package upstreams

import (
	"net/http"

	"github.com/caddyserver/caddy/v2"
	"github.com/caddyserver/caddy/v2/caddyconfig/caddyfile"
	"github.com/caddyserver/caddy/v2/modules/caddyhttp/reverseproxy"
	"go.uber.org/zap"
)

func init() {
	caddy.RegisterModule(K8sNodeUpstreams{})
}

type K8sNodeUpstreams struct {
	FilterLabel string `json:"filter_label,omitempty"`
	
	logger     *zap.Logger
}

// CaddyModule returns the Caddy module information.
func (K8sNodeUpstreams) CaddyModule() caddy.ModuleInfo {
	return caddy.ModuleInfo{
		ID:  "http.reverse_proxy.upstreams.k8s_node",
		New: func() caddy.Module { return new(K8sNodeUpstreams) },
	}
}

// Provision sets up the module.
func (u *K8sNodeUpstreams) Provision(ctx caddy.Context) error {
	u.logger = ctx.Logger(u)

	return nil
}

func (u K8sNodeUpstreams) GetUpstreams(r *http.Request) ([]*reverseproxy.Upstream, error) {
	var upstreams []*reverseproxy.Upstream

	upstreams = append(upstreams, &reverseproxy.Upstream{
		Dial: "10.128.0.3:32080",
	})
	return upstreams, nil
}

// UnmarshalCaddyfile implements caddyfile.Unmarshaler. Syntax:
//
//	dynamic k8s_node {
//		filter_label	<filter_label>
//	}
func (u *K8sNodeUpstreams) UnmarshalCaddyfile(d *caddyfile.Dispenser) error {
	for d.Next() {
		args := d.RemainingArgs()

		if len(args) > 0 {
			return d.ArgErr()
		}

		for d.NextBlock(0) {
			switch d.Val() {
			case "filter_label":
				if !d.NextArg() {
					return d.ArgErr()
				}
				if u.FilterLabel != "" {
					return d.Errf("k8s_node filter label has already been specified")
				}
				u.FilterLabel = d.Val()
			default:
				return d.Errf("unrecognized k8s_node option '%s'", d.Val())
			}
		}
	}
	return nil
}

func (u K8sNodeUpstreams) String() string {
	return "k8s_node_upstream"
}

// Interface guards
var (
	_ caddy.Provisioner           = (*K8sNodeUpstreams)(nil)
	_ reverseproxy.UpstreamSource = (*K8sNodeUpstreams)(nil)
	_ caddyfile.Unmarshaler       = (*K8sNodeUpstreams)(nil)
)
