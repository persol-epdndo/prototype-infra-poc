import * as pulumi from '@pulumi/pulumi'
import * as gcp from '@pulumi/gcp'
import * as k8s from '@pulumi/kubernetes'

const providerCfg = new pulumi.Config('gcp')
const project = providerCfg.require('project')
const gcpRegion = providerCfg.get('region')
const cfg = new pulumi.Config()
const nodesPerZone = cfg.requireNumber('nodesPerZone')
const githubToken = cfg.requireSecret('githubToken')
const zones = gcp.compute.getZones()

const domainNames = 'v3.poc.epdndo.com'
const gitOpsConfigs = [
  {
    name: 'proto3rd',
    secret: {
      username: 'dekimasoon',
      password: githubToken,
    },
    repository: {
      url: 'https://github.com/persol-epdndo/proto3rd/',
      branch: 'main',
      targets: [
        {
          namespaceSuffix: 'production',
          path: './deploy',
        },
      ],
    },
  },
]

const network = new gcp.compute.Network('network', {
  autoCreateSubnetworks: false,
})

const subnet = new gcp.compute.Subnetwork('subnet', {
  ipCidrRange: '10.128.0.0/12',
  network: network.id,
  privateIpGoogleAccess: true,
})

const natRouter = new gcp.compute.Router('nat-router', {
  network: network.id,
})

const nat = new gcp.compute.RouterNat('nat', {
  router: natRouter.name,
  natIpAllocateOption: 'AUTO_ONLY',
  sourceSubnetworkIpRangesToNat: 'ALL_SUBNETWORKS_ALL_IP_RANGES',
  logConfig: {
    enable: true,
    filter: 'ALL',
  },
})

const cluster = new gcp.container.Cluster('cluster', {
  addonsConfig: {
    dnsCacheConfig: {
      enabled: true,
    },
    httpLoadBalancing: {
      disabled: true,
    },
  },
  //   monitoringConfig: {
  //     managedPrometheus: {
  //       enabled: true,
  //     },
  //   },
  binaryAuthorization: {
    evaluationMode: 'PROJECT_SINGLETON_POLICY_ENFORCE',
  },
  datapathProvider: 'ADVANCED_DATAPATH',
  initialNodeCount: 1,
  ipAllocationPolicy: {
    clusterIpv4CidrBlock: '/14',
    servicesIpv4CidrBlock: '/20',
  },
  location: zones.then((x) => x.names[0]),
  masterAuthorizedNetworksConfig: {
    cidrBlocks: [
      {
        cidrBlock: '0.0.0.0/0',
        displayName: 'All networks',
      },
    ],
  },
  network: network.name,
  networkingMode: 'VPC_NATIVE',
  privateClusterConfig: {
    enablePrivateNodes: true,
    enablePrivateEndpoint: false,
    masterIpv4CidrBlock: '10.100.0.0/28',
  },
  removeDefaultNodePool: true,
  releaseChannel: {
    channel: 'STABLE',
  },
  subnetwork: subnet.name,
  workloadIdentityConfig: {
    workloadPool: `${project}.svc.id.goog`,
  },
})

const nodepoolSA = new gcp.serviceaccount.Account('nodepool-sa', {
  accountId: pulumi.interpolate`${cluster.name}-np-1-sa`,
  displayName: 'GKE Nodepool Service Account',
})

const nodepoolSARoles = [
  {
    name: 'node-service-account',
    role: 'roles/container.nodeServiceAccount',
  },
]
nodepoolSARoles.map((x) => {
  new gcp.projects.IAMMember(`nodepool-sa-${x.name}-iam-binding`, {
    project: project,
    role: x.role,
    member: pulumi.interpolate`serviceAccount:${nodepoolSA.email}`,
  })
})

const nodeAllowMasterTcp8443Firewall = new gcp.compute.Firewall(
  'node-allow-master-tcp8443-firewall',
  {
    network: network.name,
    direction: 'INGRESS',
    allows: [
      {
        protocol: 'tcp',
        ports: ['8443'],
      },
    ],
    sourceRanges: ['10.100.0.0/28'],
    targetTags: ['allow-master-tcp-8334'],
  },
)

const nodepool = new gcp.container.NodePool('nodepool', {
  cluster: cluster.id,
  nodeCount: 2,
  nodeConfig: {
    spot: true,
    machineType: 'e2-small',
    diskSizeGb: 16,
    diskType: 'pd-standard',
    oauthScopes: ['https://www.googleapis.com/auth/cloud-platform'],
    serviceAccount: nodepoolSA.email,
    tags: ['allow-master-tcp-8334'],
  },
})

const kubeconfig = pulumi.interpolate`apiVersion: v1
clusters:
- cluster:
    certificate-authority-data: ${cluster.masterAuth.clusterCaCertificate}
    server: https://${cluster.endpoint}
  name: ${cluster.name}
contexts:
- context:
    cluster: ${cluster.name}
    user: ${cluster.name}
  name: ${cluster.name}
current-context: ${cluster.name}
kind: Config
preferences: {}
users:
- name: ${cluster.name}
  user:
    exec:
      apiVersion: client.authentication.k8s.io/v1beta1
      command: gke-gcloud-auth-plugin
      installHint: Install gke-gcloud-auth-plugin for use with kubectl by following
        https://cloud.google.com/blog/products/containers-kubernetes/kubectl-auth-changes-in-gke
      provideClusterInfo: true
`

const k8sProvider = new k8s.Provider('k8s-provider', {
  kubeconfig,
  enableServerSideApply: true,
})

const disableKubeDNSAutoscalerPatch = new k8s.apps.v1.DeploymentPatch(
  'disable-kube-dns-autoscaler-patch',
  {
    metadata: {
      namespace: 'kube-system',
      name: 'kube-dns-autoscaler',
    },
    spec: {
      replicas: 0,
    },
  },
  { provider: k8sProvider },
)

const minimizeKubeDNSPatch = new k8s.apps.v1.DeploymentPatch(
  'minimize-kube-dns-patch',
  {
    metadata: {
      namespace: 'kube-system',
      name: 'kube-dns',
    },
    spec: {
      replicas: 1,
    },
  },
  { provider: k8sProvider },
)

const nginxNamespace = new k8s.core.v1.Namespace(
  'nginx-namespace',
  {
    metadata: {
      name: 'ingress-nginx',
    },
  },
  {
    provider: k8sProvider,
  },
)
const nginx = new k8s.helm.v3.Release(
  'ingress-nginx',
  {
    chart: 'ingress-nginx',
    namespace: 'ingress-nginx',
    repositoryOpts: {
      repo: 'https://kubernetes.github.io/ingress-nginx',
    },
    values: {
      controller: {
        service: {
          type: 'NodePort',
          nodePorts: {
            http: 32080,
            https: 32443,
          },
        },
      },
    },
  },
  { provider: k8sProvider },
)

const flux2Namespace = new k8s.core.v1.Namespace(
  'flux2-namespace',
  {
    metadata: {
      name: 'flux2',
    },
  },
  {
    provider: k8sProvider,
  },
)
const flux2 = new k8s.helm.v3.Release(
  'flux2',
  {
    chart: 'flux2',
    namespace: flux2Namespace.metadata.name,
    repositoryOpts: {
      repo: 'https://fluxcd-community.github.io/helm-charts/',
    },
    values: [
      'helmController',
      'imageAutomationController',
      'imageReflectionController',
      'kustomizeController',
      'notificationController',
      'sourceController',
    ].reduce<any>((acc, x) => {
      acc[x] = {
        resources: {
          requests: {
            cpu: '50m',
            memory: '48Mi',
          },
        },
      }
      return acc
    }, {}),
  },
  {
    provider: k8sProvider,
  },
)

gitOpsConfigs.map((x) => {
  const secretName = `git-secret-${x.name}`
  new k8s.core.v1.Secret(
    secretName,
    {
      metadata: {
        name: secretName,
        namespace: flux2Namespace.metadata.name,
      },
      stringData: x.secret,
    },
    { provider: k8sProvider },
  )

  const repositoryName = `git-repository-${x.name}`
  new k8s.apiextensions.CustomResource(
    repositoryName,
    {
      apiVersion: 'source.toolkit.fluxcd.io/v1beta2',
      kind: 'GitRepository',
      metadata: {
        name: repositoryName,
        namespace: flux2Namespace.metadata.name,
      },
      spec: {
        interval: '1m0s',
        url: x.repository.url,
        secretRef: {
          name: secretName, // Flux user PAT (read-only access)
        },
        ref: {
          branch: x.repository.branch,
        },
      },
    },
    { provider: k8sProvider },
  )

  x.repository.targets.map((t) => {
    const gitOpsName = `git-ops-${x.name}`
    const targetNamespace = `${x.name}-${t.namespaceSuffix}`
    new k8s.core.v1.Namespace(
      `${targetNamespace}-namespace`,
      {
        metadata: {
          name: targetNamespace,
        },
      },
      { provider: k8sProvider },
    )
    new k8s.apiextensions.CustomResource(
      gitOpsName,
      {
        apiVersion: 'kustomize.toolkit.fluxcd.io/v1beta2',
        kind: 'Kustomization',
        metadata: {
          name: gitOpsName,
          namespace: flux2Namespace.metadata.name,
        },
        spec: {
          interval: '60m0s', // detect drift and undo kubectl edits every hour
          wait: true, // wait for all applied resources to become ready
          timeout: '3m0s', // give up waiting after three minutes
          retryInterval: '2m0s', // retry every two minutes on apply or waiting failures
          prune: true, // remove stale resources from cluster
          force: false, // enable this to recreate resources on immutable fields changes
          targetNamespace, // set the namespace for all resources
          sourceRef: {
            kind: 'GitRepository',
            name: repositoryName,
            namespace: flux2Namespace.metadata.name,
          },
          path: t.path,
        },
      },
      { provider: k8sProvider },
    )
  })
})

const appName = 'sample-app'
const deployment = new k8s.apps.v1.Deployment(
  `sample-app-deployment`,
  {
    metadata: { name: appName },
    spec: {
      replicas: 3,
      selector: {
        matchLabels: { app: appName },
      },
      template: {
        metadata: {
          labels: { app: appName },
        },
        spec: {
          containers: [
            {
              name: appName,
              image: 'paulbouwer/hello-kubernetes:1.8',
              ports: [{ containerPort: 8080 }],
              env: [{ name: 'MESSAGE', value: 'Hello K8s!' }],
            },
          ],
        },
      },
    },
  },
  { provider: k8sProvider },
)

const service = new k8s.core.v1.Service(
  `sample-app-service`,
  {
    metadata: { name: appName },
    spec: {
      type: 'ClusterIP',
      ports: [{ port: 80, targetPort: 8080 }],
      selector: { app: appName },
    },
  },
  { provider: k8sProvider },
)

const ingress = new k8s.networking.v1.Ingress(
  `sample-app-ingress`,
  {
    metadata: {
      name: 'sample-app-ingress',
    },
    spec: {
      ingressClassName: 'nginx',
      rules: [
        {
          host: domainNames,
          http: {
            paths: [
              {
                pathType: 'Prefix',
                path: '/',
                backend: {
                  service: {
                    name: appName,
                    port: { number: 80 },
                  },
                },
              },
            ],
          },
        },
      ],
    },
  },
  { provider: k8sProvider },
)

const caddyIp = new gcp.compute.Address('caddy-ip')

const allowHttp = new gcp.compute.Firewall('allow-http-firewall', {
  network: network.name,
  direction: 'INGRESS',
  allows: [
    {
      protocol: 'tcp',
      ports: ['80'],
    },
  ],
  sourceRanges: ['0.0.0.0/0'],
  targetTags: ['allow-http'],
})

const allowHttps = new gcp.compute.Firewall('allow-https-firewall', {
  network: network.name,
  direction: 'INGRESS',
  allows: [
    {
      protocol: 'tcp',
      ports: ['443'],
    },
  ],
  sourceRanges: ['0.0.0.0/0'],
  targetTags: ['allow-https'],
})

const allowSSH = new gcp.compute.Firewall('allow-ssh-firewall', {
  network: network.name,
  direction: 'INGRESS',
  allows: [
    {
      protocol: 'tcp',
      ports: ['22'],
    },
  ],
  sourceRanges: ['0.0.0.0/0'],
  targetTags: ['allow-ssh'],
})

const caddySA = new gcp.serviceaccount.Account('caddy-sa', {
  accountId: pulumi.interpolate`caddy-sa`,
  displayName: 'Caddy Service Account',
})

const caddySARoles = [
  {
    name: 'compute-viewer',
    role: 'roles/compute.viewer',
  },
  {
    name: 'log-writer',
    role: 'roles/logging.logWriter',
  },
  {
    name: 'metric-writer',
    role: 'roles/monitoring.metricWriter',
  },
  {
    name: 'monitoring-viewer',
    role: 'roles/monitoring.viewer',
  },
]
caddySARoles.map((x) => {
  new gcp.projects.IAMMember(`caddy-sa-${x.name}-iam-binding`, {
    project: project,
    role: x.role,
    member: pulumi.interpolate`serviceAccount:${caddySA.email}`,
  })
})

const caddy = new gcp.compute.Instance(
  'caddy',
  {
    machineType: 'e2-small',
    zone: zones.then((x) => x.names[0]),
    networkInterfaces: [
      {
        network: network.id,
        subnetwork: subnet.id,
        accessConfigs: [{ natIp: caddyIp.address }],
      },
    ],
    bootDisk: {
      initializeParams: {
        size: 10,
        type: 'pd-standard',
        image: 'projects/cos-cloud/global/images/family/cos-stable',
      },
    },
    metadata: {
      'gce-container-declaration': `spec:
  containers:
  - image: ghcr.io/persol-epdndo/prototype-infra-poc/caddy:8
    name: caddy
    env:
    - name: DOMAIN_NAMES
      value: ${domainNames}
    securityContext:
      privileged: false
    stdin: false
    tty: false
    volumeMounts: []
  volumes: []
  restartPolicy: Always
`,
      'google-logging-enabled': 'true',
      'google-monitoring-enabled': 'true',
    },
    tags: ['allow-http', 'allow-https', 'allow-ssh'],
    serviceAccount: {
      email: caddySA.email,
      scopes: ['cloud-platform'],
    },
  },
  {
    deleteBeforeReplace: true,
  },
)
