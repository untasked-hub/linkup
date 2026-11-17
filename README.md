# linkup-call

This application is open source under the license in `LICENSE`. Public readability is not itself a license.

## Build, test, and deploy

```bash
docker compose up --build
docker compose run --rm web echo untasked-check
```

## Self-hosting

Copy `.env.example` to `.env` and point `DATABASE_URL` at your own PostgreSQL. Point `STORAGE_URL` at any S3-compatible bucket. `untasked.yaml` describes the web process and an optional release command for migrations.

A hosted UNTASKED app injects PostgreSQL and object storage for the running process. Those credentials are not part of this repository. Deleting the hosted app does not delete this source. Restoring the source does not restore production rows or uploads.

Code rollback redeploys a previous image. It does not reverse database migrations or restore user data.