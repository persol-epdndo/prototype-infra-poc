FROM caddy:builder AS builder

COPY go.mod go.sum upstreams.go /tmp/caddy/

RUN xcaddy build \
    --with prototype-infra.io/caddy=/tmp/caddy/

FROM caddy:latest

COPY --from=builder /usr/bin/caddy /usr/bin/caddy
COPY Caddyfile /etc/caddy/Caddyfile
