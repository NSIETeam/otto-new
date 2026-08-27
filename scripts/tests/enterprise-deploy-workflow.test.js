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
    expect(workflow).toContain("sudo -S -p '' -v");
    expect(workflow).not.toContain(
      'sudo -S -p \'\' -v "${{ secrets.DEPLOY_SUDO_PASSWORD }}"',
    );
  });

  it('does not pin deployment to the retired V1.9.13 source line', () => {
    expect(workflow).not.toContain('DEPLOY_V1.9.13');
    expect(workflow).not.toContain('test "$TAG" = \'1.9.13\'');
  });
});
