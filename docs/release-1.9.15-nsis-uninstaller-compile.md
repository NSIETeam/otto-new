# NSIS installer-only variables — 1.9.15 release repair

Formal run `34452159462`, attempt 1, source
`7e630fbf4313593b38685723e05fe99bc2bd6190` stopped while compiling the
Windows uninstaller: warning 6001 reported unused `OttoSafetyOldPath`, and
warnings-as-errors correctly rejected the build. No installer acceptance,
publication, mirror update, or production deployment ran in that attempt.

The fix conditionally declares the three installer-only `Old*` variables
outside `BUILD_UNINSTALLER`. All six shared variables remain available to
both targets. Removing the two added preprocessor lines reproduces the
previous guard byte-for-byte. Path checks, registry validation, bounded
inspection, and preservation exit code 73 are unchanged; strict compilation
is not weakened.

Regression validation uses the exact production include and actual NSIS
3.04 with `/WX`, separately compiling installer and uninstaller fixtures.
The original uninstaller failure was reproduced before the fix. After it,
both compilations and two static contract checks passed. These tests do
not execute any generated executable. The existing 23 executable-marker
cases were explicitly not selected for this local compile-only check.

The compiler-dependent checks skip when Windows/NSIS is unavailable. They
do not establish real upgrade success: a new formal run must still build
the complete platform artifacts, seed the fixed official 1.9.14 Windows
installer on a hosted runner, and pass the unchanged candidate upgrade
and directory-preservation acceptance before publication.
