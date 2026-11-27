# Cluster-agnostic Tiltfile for wortlaut development.
# - Default: local kind cluster (`kind-wortlaut-dev`), bundled Postgres+RustFS,
#   Parakeet ONNX CPU ASR (`wortlaut-asr-cpu`), native docker_build + live_update.
# - Remote cluster: set WORTLAUT_KUBE_CONTEXT, WORTLAUT_DEV_REGISTRY, and
#   WORTLAUT_DEV_DOMAIN in .dev/dev.env (or environment) to use remote BuildKit.

dev_env = {}
if os.path.exists('.dev/dev.env'):
    for line in str(read_file('.dev/dev.env')).splitlines():
        line = line.strip()
        if line and not line.startswith('#') and '=' in line:
            k, v = line.split('=', 1)
            dev_env[k.strip()] = v.strip()

if not os.getenv('KUBECONFIG', ''):
    fail('Use make setup and make dev for the project-local .dev/kubeconfig')

target_context = os.getenv('WORTLAUT_KUBE_CONTEXT', dev_env.get('WORTLAUT_KUBE_CONTEXT', '')).strip()
if not target_context:
    fail('Set WORTLAUT_KUBE_CONTEXT (run make setup first)')

allow_k8s_contexts(target_context)
if k8s_context() != target_context:
    fail('Expected Kubernetes context ' + target_context + ', got ' + k8s_context())

username = str(local('id -un', quiet=True)).strip()
namespace = os.getenv('WORTLAUT_NAMESPACE', 'wortlaut-' + username)
if len(namespace) > 63 or any([c not in 'abcdefghijklmnopqrstuvwxyz0123456789-' for c in namespace.elems()]):
    fail('Namespace must be a valid Kubernetes DNS label: ' + namespace)

is_kind = target_context.startswith('kind-')
asr_backend = os.getenv('WORTLAUT_ASR_BACKEND', dev_env.get('WORTLAUT_ASR_BACKEND', 'parakeet' if is_kind else 'qwen3'))
asr_device = os.getenv('WORTLAUT_ASR_DEVICE', dev_env.get('WORTLAUT_ASR_DEVICE', 'cpu' if is_kind else 'auto'))
asr_quantization = os.getenv('WORTLAUT_ASR_QUANTIZATION', dev_env.get('WORTLAUT_ASR_QUANTIZATION', 'auto'))
bundled_enabled = os.getenv('WORTLAUT_DEV_BUNDLED', dev_env.get('WORTLAUT_DEV_BUNDLED', 'true')).lower() in ('1', 'true', 'yes')
dev_domain = os.getenv('WORTLAUT_DEV_DOMAIN', dev_env.get('WORTLAUT_DEV_DOMAIN', 'wortlaut.local'))
ingress_enabled = os.getenv('WORTLAUT_DEV_INGRESS', dev_env.get('WORTLAUT_DEV_INGRESS', 'false' if is_kind else 'true')).lower() in ('1', 'true', 'yes')

asr_use_cpu_image = (asr_backend == 'parakeet' and asr_device == 'cpu')
asr_image_name = 'wortlaut-asr-cpu' if asr_use_cpu_image else 'wortlaut-asr'
asr_dockerfile = 'services/asr/Dockerfile.cpu' if asr_use_cpu_image else 'services/asr/Dockerfile'

update_settings(max_parallel_updates=1)
build_env = {
    'KUBECONFIG': os.getenv('KUBECONFIG'),
    'WORTLAUT_KUBE_CONTEXT': target_context,
    'WORTLAUT_NAMESPACE': namespace,
    'WORTLAUT_DEV_BUNDLED': 'true' if bundled_enabled else 'false',
}

meeting_ignore = [
    '**/.venv', '**/__pycache__', '**/node_modules', '**/dist', '**/dist-worker',
    'worker/public/vendor', '**/.pytest_cache', '**/.ruff_cache',
]
worker_ignore = ['**/node_modules', '**/dist', '**/dist-worker', 'worker/public/vendor', '**/__pycache__']
asr_ignore = ['**/__pycache__', '**/.pytest_cache', '**/.ruff_cache']

if is_kind:
    docker_build(
        'wortlaut-meeting',
        '.',
        dockerfile='services/meeting/Dockerfile',
        only=['services/meeting', 'worker', 'site'],
        ignore=meeting_ignore,
        live_update=[
            sync('services/meeting/src', '/app/src'),
        ],
    )
    docker_build(
        asr_image_name,
        '.',
        dockerfile=asr_dockerfile,
        only=['services/asr'],
        ignore=asr_ignore,
    )
    docker_build(
        'wortlaut-worker',
        '.',
        dockerfile='services/worker/Dockerfile',
        only=['worker', 'services/worker/Dockerfile'],
        ignore=worker_ignore,
        match_in_env_vars=True,
    )
else:
    dev_registry_host = os.getenv('WORTLAUT_DEV_REGISTRY', dev_env.get('WORTLAUT_DEV_REGISTRY', 'localhost:5000'))
    default_registry(dev_registry_host.rstrip('/') + '/' + namespace)
    custom_build(
        'wortlaut-meeting', './scripts/build.sh meeting',
        deps=['services/meeting', 'worker', 'site', 'scripts/build.sh', '.dockerignore'],
        skips_local_docker=True, disable_push=True, env=build_env, ignore=meeting_ignore,
    )
    custom_build(
        asr_image_name, './scripts/build.sh ' + ('asr-cpu' if asr_use_cpu_image else 'asr'),
        deps=['services/asr', 'scripts/build.sh', '.dockerignore'],
        skips_local_docker=True, disable_push=True, env=build_env, ignore=asr_ignore,
    )
    custom_build(
        'wortlaut-worker', './scripts/build.sh worker',
        deps=['worker', 'services/worker/Dockerfile', 'scripts/build.sh', '.dockerignore'],
        skips_local_docker=True, disable_push=True, match_in_env_vars=True, env=build_env, ignore=worker_ignore,
    )

hostname = namespace + '.' + dev_domain if ingress_enabled else 'wortlaut.local'
helm_sets = [
    'host=' + hostname,
    'bundled.enabled=' + ('true' if bundled_enabled else 'false'),
    'ingress.enabled=' + ('true' if ingress_enabled else 'false'),
    'images.meeting=wortlaut-meeting',
    'images.worker=wortlaut-worker',
    'images.asr=wortlaut-asr',
    'images.asrCpu=wortlaut-asr-cpu',
    'images.pullPolicy=IfNotPresent',
    'asr.backend=' + asr_backend,
    'asr.device=' + asr_device,
    'asr.quantization=' + asr_quantization,
]

raw_objects = decode_yaml_stream(helm('charts/wortlaut', name='wortlaut', namespace=namespace, set=helm_sets))
allowed_kinds = [
    'Deployment', 'StatefulSet', 'Service', 'ServiceAccount', 'Role', 'RoleBinding',
    'ConfigMap', 'Secret', 'Ingress', 'PersistentVolumeClaim',
]
objects = []
for obj in raw_objects:
    if obj['kind'] not in allowed_kinds:
        fail('Refusing cluster-scoped or unexpected object: ' + obj['kind'])
    # Tilt invokes `helm template` offline where `lookup` cannot see existing cluster Secrets;
    # let `dev-secrets` manage persistent Secrets idempotently so passwords never rotate on reload.
    if obj['kind'] == 'Secret':
        continue
    obj['metadata']['namespace'] = namespace
    if is_kind and obj['kind'] == 'Deployment' and obj['metadata']['name'] == 'wortlaut-meeting':
        obj['spec']['template']['spec']['containers'][0]['command'] = [
            'sh', '-c',
            'alembic upgrade head && uvicorn wortlaut.app:app --host 0.0.0.0 --port 8000 --reload --reload-dir /app/src',
        ]
    objects.append(obj)
k8s_yaml(encode_yaml_stream(objects))

local_resource(
    'dev-secrets',
    cmd='python3 scripts/dev-secrets.py',
    deps=[
        'scripts/dev-secrets.py', '.dev/meet.env', '.dev/teams.env', '.dev/zoom.env',
        '.dev/meet-storage-state.json', '.dev/mail.env', '.dev/webex.env',
    ],
    env=build_env,
)

meeting_deps = ['dev-secrets']
if bundled_enabled:
    k8s_resource('wortlaut-postgres', port_forwards='34632:5432', resource_deps=['dev-secrets'])
    k8s_resource('wortlaut-rustfs', port_forwards='34609:9000', resource_deps=['dev-secrets'])
    meeting_deps = ['wortlaut-postgres', 'wortlaut-rustfs', 'dev-secrets']

k8s_resource('wortlaut-meeting', port_forwards='34601:8000', resource_deps=meeting_deps)
k8s_resource('wortlaut-asr', port_forwards='34602:8000', resource_deps=['dev-secrets'])
