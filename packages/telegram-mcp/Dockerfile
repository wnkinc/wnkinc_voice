# syntax=docker/dockerfile:1
# chigwell/telegram-mcp on Lambda: the engine pinned by commit + sha256, its deps from
# the engine's own uv.lock, and Lambda Web Adapter forwarding Function URL requests.
ARG PYTHON=public.ecr.aws/docker/library/python:3.13-slim

FROM ${PYTHON} AS build
COPY --from=ghcr.io/astral-sh/uv:0.8.22 /uv /bin/uv
ARG TG_COMMIT=c95e136f5f852f4ce6f400dc03d0d9f6ef0b4e42
ADD --checksum=sha256:f5e132b075f1cb2ac285f9df9c6b63705d3bce25d9b0dd819867b89bda248a9b \
    https://github.com/chigwell/telegram-mcp/archive/${TG_COMMIT}.tar.gz /tmp/engine.tar.gz
RUN mkdir /engine && tar -xzf /tmp/engine.tar.gz -C /engine --strip-components=1
WORKDIR /engine
ENV UV_PROJECT_ENVIRONMENT=/venv UV_PYTHON_DOWNLOADS=never UV_COMPILE_BYTECODE=1
RUN uv sync --frozen --no-dev --no-install-project --python /usr/local/bin/python3 \
    && uv pip install --python /venv/bin/python boto3 \
    && /venv/bin/python -m compileall -q --invalidation-mode unchecked-hash /engine

FROM ${PYTHON}
COPY --from=public.ecr.aws/awsguru/aws-lambda-adapter:0.9.1 /lambda-adapter /opt/extensions/lambda-adapter
COPY --from=build /venv /venv
COPY --from=build /engine /engine
COPY server.py /engine/server.py
# Lambda's filesystem is read-only outside /tmp.
ENV PATH=/venv/bin:$PATH \
    PYTHONUNBUFFERED=1 \
    HOME=/tmp \
    XDG_STATE_HOME=/tmp/state \
    MCP_TRANSPORT=http \
    AWS_LWA_PORT=8080
WORKDIR /engine
CMD ["python", "server.py"]
