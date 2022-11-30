FROM caddy:builder AS builder

COPY go.mod go.sum upstreams.go /tmp/caddy/

RUN xcaddy build \
    --with prototype-infra.io/caddy=/tmp/caddy/ \
    --with github.com/caddyserver/forwardproxy@caddy2

FROM caddy:latest

COPY --from=builder /usr/bin/caddy /usr/bin/caddy
COPY Caddyfile /etc/caddy/Caddyfile
