/** Keep an outer service-window close from silently discarding an embedded profile draft. */
export function confirmProfileLeave(
  root: Element | null,
  confirm: (message: string) => boolean = (message) => window.confirm(message),
): boolean {
  return (
    !root?.querySelector('[data-profile-dirty="true"]') ||
    confirm('企业资料尚未保存，确定放弃修改并离开吗？')
  );
}
