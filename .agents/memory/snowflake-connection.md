---
name: Snowflake connection quirks
description: Lessons from setting up Snowflake key-pair auth in the api-server
---

- Users may paste the private key secret as a bare base64 DER body (no PEM headers, no newlines) and it may be passphrase-encrypted (PBES2). The connection module normalizes: re-wrap to PEM, try ENCRYPTED PRIVATE KEY / PRIVATE KEY / RSA PRIVATE KEY headers, decrypt with SNOWFLAKE_PRIVATE_KEY_PASSPHRASE via node:crypto, export unencrypted PKCS#8 for the SDK.
  **Why:** snowflake-sdk rejects anything but a clean PEM; the raw pasted secret failed with "Invalid private key".
- snowflake-sdk cannot be bundled by esbuild (pulls optional cloud deps like @azure/storage-blob at require time). It must stay in the `external` list in the api-server build config.
- Session defaults: warehouse PC_DBT_WH, role PC_DBT_ROLE, db PC_DBT_DB, schema DBT_ECORONADO (env: SNOWFLAKE_DATABASE/SNOWFLAKE_SCHEMA shared env vars; rest are secrets).
- Gotcha: PC_DBT_ROLE can SHOW the 121 tables in PC_DBT_DB.DBT_ECORONADO but initially lacked SELECT grants (tables owned by dbt users' roles). Admin must GRANT SELECT ON ALL/FUTURE TABLES IN SCHEMA to PC_DBT_ROLE.
- Verify endpoint: GET /api/snowflake/status (probe query returning session context or a clear error).
