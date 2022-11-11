import * as pulumi from '@pulumi/pulumi'
import * as gcp from '@pulumi/gcp'
import * as k8s from '@pulumi/kubernetes'

const providerCfg = new pulumi.Config('gcp')
const project = providerCfg.require('project')
const gcpRegion = providerCfg.get('region')
const cfg = new pulumi.Config()
const nodesPerZone = cfg.getNumber('nodesPerZone')
const zones = gcp.compute.getZones()

const domainNames = 'sampleapp.poc.epdndo.com'

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

const nodepoolSABinding = new gcp.projects.IAMBinding('nodepool-sa-iam-binding', {
  project: project,
  members: [pulumi.interpolate`serviceAccount:${nodepoolSA.email}`],
  role: 'roles/container.nodeServiceAccount',
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
    diskSizeGb: 20,
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
})

const nginx = new k8s.helm.v3.Release(
  'ingress-nginx',
  {
    chart: 'ingress-nginx',
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
          host: 'sampleapp.poc.epdndo.com',
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
        image: 'projects/cos-cloud/global/images/family/cos-stable',
      },
    },
    metadata: {
      'gce-container-declaration': `spec:
  containers:
  - image: ghcr.io/persol-epdndo/prototype-infra-poc/caddy:7
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
  },
  {
    deleteBeforeReplace: true,
  },
)
