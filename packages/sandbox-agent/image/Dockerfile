# Sandbox image for AI coding agents. Built by Lambda MicroVMs on top of the
# managed AL2023 base; the running snapshot is taken after /ready returns 200.
FROM public.ecr.aws/lambda/microvms:al2023-minimal

# Toolchain available to the coding agent inside the sandbox. Keep this list
# small: everything here ends up in the disk snapshot. Missing tools can be
# added at runtime with `sudo dnf install`.
ARG SANDBOX_PACKAGES="nodejs22 nodejs22-npm python3 python3-pip git tar gzip unzip jq curl-minimal make gcc gcc-c++ shadow-utils procps-ng which findutils diffutils"
RUN dnf install -y ${SANDBOX_PACKAGES} \
 && alternatives --install /usr/bin/node node /usr/bin/node-22 100 || true \
 && dnf clean all && rm -rf /var/cache/dnf /var/log/dnf*

# Commands run as this user, like a CI runner. The agent process itself stays
# root so a stray `pkill` cannot take down the control plane. The container has
# no_new_privileges set, so real setuid sudo cannot work; /usr/bin/sudo is a shim
# that forwards to the root agent over a group-restricted unix socket.
RUN useradd -m -u 1000 -s /bin/bash sandbox \
 && mkdir -p /workspace /tmp/sandbox-agent/transfers /run/sandbox-agent && chown sandbox:sandbox /workspace \
 && git config --system init.defaultBranch main \
 && git config --system safe.directory '*'

COPY agent.mjs sudo.mjs /opt/sandbox-agent/
RUN printf '#!/bin/sh\nexec /usr/bin/node /opt/sandbox-agent/sudo.mjs "$@"\n' > /usr/bin/sudo && chmod 0755 /usr/bin/sudo

ENV SANDBOX_WORKSPACE=/workspace \
    SANDBOX_EXEC_USER=sandbox \
    SANDBOX_API_PORT=8080 \
    SANDBOX_HOOK_PORT=9000 \
    SANDBOX_ROOT_SOCKET=/run/sandbox-agent/root.sock

WORKDIR /workspace
EXPOSE 8080 9000
CMD ["node", "/opt/sandbox-agent/agent.mjs"]
