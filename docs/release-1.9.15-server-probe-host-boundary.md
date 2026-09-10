# Target-native server probing — 1.9.15 release repair

Formal run `34458070286`, attempt 1, source
`b46f98f6ab92df88b2a9e3e428338e15e55909cb` completed NSIS installer,
uninstaller and blockmap generation. It then failed because the macOS ARM
builder started the Windows archive's server with the host Node runtime.
Sharp correctly contained Windows dependencies, not macOS ARM dependencies.
Windows upgrade acceptance, release creation and deployment never ran.

The packaged-runtime verifier keeps all archive, version, native-identity,
Sharp, SQLCipher and provenance checks. Strict `--probe-server-bin` requires
the actual host platform and architecture to match the target before
extraction or execution. Windows cross-building uses the explicit
`--probe-server-bin-if-host` mode: a foreign target reports
`deferred-native-probe`, never successful dynamic verification. A matching
host still executes the real probe and propagates its failures. Invalid
targets and conflicting modes are rejected.

The release workflow remains unchanged: after installing on the Windows
runner it uses installed Otto.exe to require actual SQLCipher, Otto-native
and strict server-bin probes. Failure prevents draft creation and deployment.
No foreign-platform dependencies were added to the Windows package.

Focused validation: 42 tests passed without skips, including real temporary
ASAR/Node child-process success and failure cases and CLI boundary checks.
This local result is test-facility evidence, not actual packaged Windows
upgrade acceptance. The next source-bound formal run must still pass complete
packaging, size, installed-runtime and old-version upgrade gates.
