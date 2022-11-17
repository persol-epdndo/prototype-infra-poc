# メモ

## caddy の方針

### 参考になりそうな実装

- https://github.com/caddyserver/caddy/blob/master/modules/caddyhttp/reverseproxy/upstreams.go
- https://caddyserver.com/docs/extending-caddy
- https://github.com/caddyserver/forwardproxy/tree/caddy2

### アクション

- まずはチュートリアルをやる
  - https://go.dev/doc/tutorial/create-module
- 次に UpstreamSource を固定値を返すような状態で実装をして、xcaddy でビルドできるところを目指す
- その状態でテストをかけるようにする
- 次に GCP の SDK を使って対象のノードの IP を取得できるようにして、動的な UpstreamSource を返せるようにする
- その状態でテストをかけるようにする

# コマンドメモ

## Docker イメージを Github パッケージに Push する方法

```sh
export CR_PAT=YOUR_TOKEN
echo $CR_PAT | docker login ghcr.io -u USERNAME --password-stdin

docker build -t caddy:latest .
docker tag caddy:latest ghcr.io/persol-epdndo/prototype-infra-poc/caddy:5
docker push ghcr.io/persol-epdndo/prototype-infra-poc/caddy:5
```
