/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const templatePath = path.resolve(
  process.cwd(),
  'deployment/enterprise-oneclick/templates/otto-enterprise.caddy',
);
const albTemplatePath = path.resolve(
  process.cwd(),
  'deployment/enterprise-oneclick/templates/otto-enterprise-alb.caddy',
);
const installerPath = path.resolve(
  process.cwd(),
  'deployment/enterprise-oneclick/install.sh',
);

describe('enterprise Caddy transport policy', () => {
  it('pins supported TLS versions and keeps attachment uploads within product limits', () => {
    const template = fs.readFileSync(templatePath, 'utf8');

    expect(template).toMatch(/protocols\s+tls1\.2\s+tls1\.3/);
    expect(template).toMatch(
      /@direct_message_upload[\s\S]*method POST[\s\S]*path \/enterprise\/messages\/\*[\s\S]*max_size 32MB/,
    );
    expect(template).toMatch(/handle\s*\{[\s\S]*max_size 1MB/);
    expect(template).toContain('reverse_proxy 127.0.0.1:7778');
  });

  it('provides a private ALB origin that rejects forged hosts and proxy-host headers', () => {
    const template = fs.readFileSync(albTemplatePath, 'utf8');

    expect(template).toContain('http://:7777');
    expect(template).toContain('@unexpected_host not host __OTTO_PUBLIC_HOST__');
    expect(template).toContain('respond @unexpected_host 421');
    expect(template).toContain('Strict-Transport-Security');
    expect(template).toMatch(
      /@direct_message_upload[\s\S]*method POST[\s\S]*path \/enterprise\/messages\/\*[\s\S]*max_size 32MB/,
    );
    expect(template).toMatch(/handle\s*\{[\s\S]*max_size 1MB/);
    expect(template).toContain(
      'header_up X-Forwarded-For {http.request.header.X-Forwarded-For}',
    );
    expect(template).toContain('header_up X-Forwarded-Proto https');
    expect(template).toContain('header_up -X-Forwarded-Host');
    expect(template).toContain('reverse_proxy 127.0.0.1:7778');
    expect(template).not.toContain('tls {');
  });

  it('installs ALB mode without asking the backend host for a public certificate', () => {
    const installer = fs.readFileSync(installerPath, 'utf8');

    expect(installer).toContain('managed|external|alb');
    expect(installer).toContain('OTTO_CADDY_MODE 只能是 managed、alb 或 external');
    expect(installer).toContain('templates/otto-enterprise-alb.caddy');
    expect(installer).toContain('http://127.0.0.1:7777');
    expect(installer).toContain('-H "Host: ${OTTO_PUBLIC_HOST}"');
    expect(installer).toContain('ALB 私网源站验收通过');
    expect(installer).toContain('&& [ ! -f "$CADDY_FRAGMENT" ]');
    expect(installer).toContain('主 Caddyfile 引用了缺失的 Otto 边缘配置');
  });
});
