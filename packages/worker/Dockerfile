# syntax=docker/dockerfile:1
# The Temporal Worker as a container Lambda. Temporal Cloud invokes it when its
# task queue has work (Serverless Workers, public preview); it polls until the
# invocation deadline nears and returns. One image: the bundled entries, the
# pre-bundled workflow code, and only the Linux/arm64 native core (the SDK ships
# every platform, 150 MB; one is 27 MB).
#
# The build context is the repo root, so the worker can take @wnk/shared as a
# workspace package; the root .dockerignore names exactly what comes in.
ARG BASE=public.ecr.aws/lambda/nodejs:22

FROM ${BASE} AS build
WORKDIR /build
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/worker/package.json packages/worker/
RUN npm ci --workspace=@wnk/worker --no-audit --no-fund
COPY packages/shared/src packages/shared/src
COPY packages/worker/tsconfig.json packages/worker/
COPY packages/worker/src packages/worker/src
COPY packages/worker/scripts packages/worker/scripts
RUN npm run build --workspace=@wnk/worker \
 && rm -rf node_modules packages/*/node_modules \
 && npm ci --workspace=@wnk/worker --omit=dev --no-audit --no-fund \
 && for d in node_modules/@temporalio/core-bridge/releases/*; do case "$d" in */aarch64-unknown-linux-gnu) ;; *) rm -rf "$d" ;; esac; done \
 && mkdir -p packages/worker/node_modules

FROM ${BASE}
COPY --from=build /build/node_modules ${LAMBDA_TASK_ROOT}/node_modules
COPY --from=build /build/packages/worker/node_modules ${LAMBDA_TASK_ROOT}/node_modules
COPY --from=build /build/packages/worker/package.json ${LAMBDA_TASK_ROOT}/package.json
COPY --from=build /build/packages/worker/lib ${LAMBDA_TASK_ROOT}/lib
# Lambda's filesystem is read-only outside /tmp.
ENV HOME=/tmp
CMD ["lib/handler.handler"]
