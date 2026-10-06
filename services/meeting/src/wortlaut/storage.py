import hashlib
import json
import struct
from functools import lru_cache

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError

from wortlaut.settings import get_settings


class ObjectConflict(ValueError):
    pass


def canonical(value: dict) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True)


class AudioStorage:
    def __init__(self):
        settings = get_settings()
        if not settings.s3_access_key or not settings.s3_secret_key:
            raise RuntimeError("S3 credentials are not configured")
        self.bucket = settings.s3_bucket
        self.client = boto3.client(
            "s3",
            endpoint_url=settings.s3_endpoint,
            aws_access_key_id=settings.s3_access_key.get_secret_value(),
            aws_secret_access_key=settings.s3_secret_key.get_secret_value(),
            region_name="us-east-1",
            config=Config(
                connect_timeout=3,
                read_timeout=10,
                retries={"max_attempts": 2},
                s3={"addressing_style": "path"},
            ),
        )
        if settings.s3_create_bucket:
            try:
                self.client.create_bucket(Bucket=self.bucket)
            except ClientError as error:
                if error.response["Error"]["Code"] not in (
                    "BucketAlreadyOwnedByYou",
                    "BucketAlreadyExists",
                ):
                    raise

    def put(self, key: str, pcm: bytes, contract: dict) -> str:
        identity = canonical(contract).encode()
        if len(identity) > 16384:
            raise ValueError("Immutable audio metadata exceeds object limit")
        # Full metadata belongs in the immutable object, not S3's 2 KiB user-
        # metadata headers (Unicode participant names can exceed that limit).
        payload = b"WORTLAUT1" + struct.pack(">I", len(identity)) + identity + pcm
        identity_hash = hashlib.sha256(identity).hexdigest()
        checksum = hashlib.sha256(pcm).hexdigest()
        try:
            self.client.put_object(
                Bucket=self.bucket,
                Key=key,
                Body=payload,
                ContentType="application/octet-stream",
                IfNoneMatch="*",
                Metadata={"contract_sha256": identity_hash, "sha256": checksum},
            )
        except ClientError as error:
            if error.response["ResponseMetadata"]["HTTPStatusCode"] not in (409, 412):
                raise
            existing = self.client.get_object(Bucket=self.bucket, Key=key)
            body = existing["Body"]
            try:
                stored = body.read()
            finally:
                body.close()
            if (
                existing["Metadata"].get("contract_sha256") != identity_hash
                or existing["Metadata"].get("sha256") != checksum
                or stored != payload
            ):
                raise ObjectConflict(
                    "Object key already contains different audio or metadata"
                ) from None
        return checksum

    def read(self, key: str) -> bytes:
        response = self.client.get_object(Bucket=self.bucket, Key=key)
        try:
            payload = response["Body"].read()
        finally:
            response["Body"].close()
        if len(payload) < 13 or payload[:9] != b"WORTLAUT1":
            raise ObjectConflict("Invalid audio object header")
        size = struct.unpack(">I", payload[9:13])[0]
        if size > 16384 or size + 13 > len(payload):
            raise ObjectConflict("Invalid immutable metadata size")
        identity, pcm = payload[13 : 13 + size], payload[13 + size :]
        if hashlib.sha256(identity).hexdigest() != response["Metadata"].get(
            "contract_sha256"
        ) or hashlib.sha256(pcm).hexdigest() != response["Metadata"].get("sha256"):
            raise ObjectConflict("Invalid audio object integrity")
        return pcm

    def delete_recording(self, recording_id):
        # Includes writes orphaned before their DB commit. The caller closes
        # admission under the occurrence row lock before removing this prefix.
        pages = self.client.get_paginator("list_objects_v2")
        for page in pages.paginate(Bucket=self.bucket, Prefix=f"audio/{recording_id}/"):
            objects = [{"Key": item["Key"]} for item in page.get("Contents", [])]
            if objects:
                response = self.client.delete_objects(
                    Bucket=self.bucket, Delete={"Objects": objects, "Quiet": True}
                )
                if response.get("Errors"):
                    raise RuntimeError("Audio cleanup did not delete all objects")


@lru_cache
def get_storage() -> AudioStorage:
    return AudioStorage()
