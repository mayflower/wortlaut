allow_k8s_contexts('data')
if k8s_context() != 'data':
    fail('wortlaut development requires --context data')

username = str(local('id -un', quiet=True)).strip()
namespace = 'wortlaut-' + username
if os.getenv('WORTLAUT_NAMESPACE', namespace) != namespace:
    fail('Use the dedicated namespace ' + namespace)
if len(namespace) > 63 or any([c not in 'abcdefghijklmnopqrstuvwxyz0123456789-' for c in username.elems()]):
    fail('Username must form a valid Kubernetes namespace')
if not os.getenv('KUBECONFIG', ''):
    fail('Use make setup and make dev for the project-local data kubeconfig')

registry = 'registry.data.mayflower.zone/' + namespace
default_registry(registry)
update_settings(max_parallel_updates=1)
build_env = {'KUBECONFIG': os.getenv('KUBECONFIG'), 'WORTLAUT_NAMESPACE': namespace}

custom_build('wortlaut-meeting', './scripts/build.sh meeting',
    deps=['services/meeting', 'worker', 'scripts/build.sh', '.dockerignore'],
    skips_local_docker=True, disable_push=True, env=build_env,
    ignore=['**/.venv', '**/__pycache__', '**/node_modules', '**/dist', '**/.pytest_cache', '**/.ruff_cache'])
custom_build('wortlaut-asr', './scripts/build.sh asr',
    deps=['services/asr', 'scripts/build.sh', '.dockerignore'],
    skips_local_docker=True, disable_push=True, env=build_env,
    ignore=['**/__pycache__', '**/.pytest_cache', '**/.ruff_cache'])
custom_build('wortlaut-worker', './scripts/build.sh worker',
    deps=['worker', 'services/worker/Dockerfile', 'scripts/build.sh', '.dockerignore'],
    skips_local_docker=True, disable_push=True, match_in_env_vars=True, env=build_env,
    ignore=['**/node_modules', '**/dist', '**/dist-worker', '**/__pycache__'])

objects = decode_yaml_stream(kustomize('deploy/dev'))
for obj in objects:
    if obj['kind'] not in ['Deployment', 'StatefulSet', 'Service', 'ServiceAccount', 'Role', 'RoleBinding', 'ConfigMap', 'Ingress', 'PersistentVolumeClaim']:
        fail('Refusing cluster-scoped or unexpected object: ' + obj['kind'])
    obj['metadata']['namespace'] = namespace
    if obj['kind'] == 'RoleBinding':
        for subject in obj['subjects']:
            if subject['kind'] == 'ServiceAccount':
                subject['namespace'] = namespace
    if obj['kind'] == 'Ingress':
        hostname = namespace + '.data.mayflower.zone'
        obj['spec']['rules'][0]['host'] = hostname
        obj['spec']['tls'][0]['hosts'] = [hostname]
    if obj['kind'] == 'ConfigMap' and obj['metadata']['name'] == 'wortlaut-config':
        obj['data']['WORTLAUT_SDK_PAGE_URL'] = 'https://' + namespace + '.data.mayflower.zone/sdk/'
        obj['data']['WORTLAUT_API_URL'] = 'https://' + namespace + '.data.mayflower.zone/'
        obj['data']['WORTLAUT_NAMESPACE'] = namespace
k8s_yaml(encode_yaml_stream(objects))

local_resource('runtime-secrets', cmd='python3 scripts/dev-secrets.py',
    deps=['scripts/dev-secrets.py'], env=build_env)
k8s_resource('postgres', port_forwards='34632:5432', resource_deps=['runtime-secrets'])
k8s_resource('minio', port_forwards='34609:9000', resource_deps=['runtime-secrets'])
k8s_resource('wortlaut-meeting', port_forwards='34601:8000', resource_deps=['postgres', 'minio', 'runtime-secrets'])
k8s_resource('wortlaut-asr', port_forwards='34602:8000', resource_deps=['runtime-secrets'])
