# syntax=docker/dockerfile:1
# The Temporal Worker as a container Lambda. Temporal Cloud invokes it when its
# task queue has work (Serverless Workers, public preview); it polls until the
# invocation deadline nears and returns. One image: the compiled handler, the
# pre-bundled workflow code, and only the Linux/arm64 native core (the SDK ships
# every platform, 150 MB; one is 27 MB).
ARG BASE=public.ecr.aws/lambda/nodejs:22

FROM ${BASE} AS build
WORKDIR /build
COPY package.json tsconfig.build.json ./
RUN npm install --no-audit --no-fund
COPY src ./src
COPY scripts ./scripts
RUN npx tsc -p tsconfig.build.json \
 && npx tsx scripts/bundle-workflows.ts \
 && npm prune --omit=dev --no-audit --no-fund \
 && for d in node_modules/@temporalio/core-bridge/releases/*; do case "$d" in */aarch64-unknown-linux-gnu) ;; *) rm -rf "$d" ;; esac; done

FROM ${BASE}
COPY --from=build /build/package.json ${LAMBDA_TASK_ROOT}/package.json
COPY --from=build /build/node_modules ${LAMBDA_TASK_ROOT}/node_modules
COPY --from=build /build/lib ${LAMBDA_TASK_ROOT}/lib
# Lambda's filesystem is read-only outside /tmp.
ENV HOME=/tmp
CMD ["lib/handler.handler"]
