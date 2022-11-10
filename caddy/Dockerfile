FROM caddy:builder AS builder

COPY ./ /tmp/caddy/

RUN xcaddy build \
    --with prototype-infra.io/caddy=/tmp/caddy/

FROM caddy:latest

COPY --from=builder /usr/bin/caddy /usr/bin/caddy
