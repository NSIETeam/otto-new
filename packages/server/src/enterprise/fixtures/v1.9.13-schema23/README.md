# Otto V1.9.13 schema-23 upgrade fixture

`data.db` was produced by the real V1.9.13 enterprise database runtime at
commit `82b5e0c101a44358efbb900b0c2be62455c2412b`. The runtime created schema 23
and its public repositories seeded synthetic records for:

- enterprise and park organizations;
- an administrator account, employee, department, position and auth session;
- organization feature configuration;
- durable enterprise knowledge;
- a park, its default services, tenant profile and a historical service ticket.

The fixture contains no production data or credentials. The account password
and session token are synthetic test material; only the password is repeated in
the acceptance test, while the existing session is verified by preserving its
stored hash. `fixture-metadata.json` locks the source commit, record identifiers
and SHA-256 of the database so an accidental fixture replacement fails closed.

Do not regenerate this database from current source: doing so would only test a
schema-24 database with a changed `user_version`, not a real V1.9.13 database.
