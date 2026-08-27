import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const workflow = readFileSync(
  path.join(repoRoot, '.github', 'workflows', 'deploy-server.yml'),
  'utf8',
);

describe('enterprise production deployment workflow', () => {
  it('passes the existing sudo secret over stdin without putting it in the remote command', () => {
    expect(workflow).toContain('test -n "${{ secrets.DEPLOY_SUDO_PASSWORD }}"');
    expect(workflow).toContain(
      'DEPLOY_SUDO_PASSWORD: ${{ secrets.DEPLOY_SUDO_PASSWORD }}',
    );
    expect(workflow).toContain('printf \'%s\\n\' "$DEPLOY_SUDO_PASSWORD" |');
    expect(workflow).toContain("sudo -k -S -p ''");
    expect(workflow).not.toContain("sudo -S -p '' -v");
    expect(workflow).not.toContain(
      'sudo -S -p \'\' -v "${{ secrets.DEPLOY_SUDO_PASSWORD }}"',
    );
  });

  it('uses an exact signed package identity without pinning the retired V1.9.13 line', () => {
    expect(workflow).not.toContain('DEPLOY_V1.9.13');
    expect(workflow).not.toContain('test "$TAG" = \'1.9.13\'');
    expect(workflow).toContain('package_identity:');
    expect(workflow).toContain(
      '[[ "$PACKAGE_ID" =~ ^[0-9a-f]{12}-[0-9a-f]{12}$ ]]',
    );
    expect(workflow).toContain(
      '${{ steps.version.outputs.package_id }}.tar.gz',
    );
  });
});
