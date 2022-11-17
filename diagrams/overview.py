from diagrams import Cluster, Diagram, Node, Edge
from diagrams.k8s.compute import Pod
from diagrams.k8s.network import Ingress
from diagrams.gcp.compute import ComputeEngine
from diagrams.gcp.network import LoadBalancing
from diagrams.gcp.storage import Storage
from diagrams.onprem.monitoring import Prometheus
from diagrams.onprem.network import Nginx
from diagrams.onprem.vcs import Git
from diagrams.azure.identity import Users

with Diagram("Overview", show=False): 

    user = Users('User')
    caddy = ComputeEngine('Caddy Server')

    with Cluster("Kubernetes"):

        with Cluster("Ingress Controller"):
            nginx= Nginx("Ingress NGINX")

        with Cluster("Applications"):
            app_pod1 = Pod("pod1")
            app_pod2 = Pod("pod2")

        with Cluster("Postgres Operator (PGO)"):
            db_instance_pod = Pod("DB-instance")
            db_backup_pod = Pod('DB-backuper')

        flux2 = Pod("Flux2 (GitOps)")

    gmp = Prometheus('GMP (Google Managed Prometheus)')
    gcs = Storage('GCS (DB Backup)')
    repository = Git('Git Repo')

    user >> caddy
    repository << flux2
    caddy >> nginx
    nginx >> [app_pod1, app_pod2] >> db_instance_pod
    db_backup_pod >> gcs
    gmp >> Edge(label="Correct metrics") >> app_pod2