/**
 * Recognises remote failures that need the user to set up credentials or
 * trust a host. Tuig disables Git and SSH prompts, so these failures are
 * expected and need a short explanation instead of raw stderr.
 */

export type RemoteOperation = "fetch" | "pull" | "push";

export type RemoteAuthFailure = {
  kind: "credentials" | "host-key" | "host-key-changed";
  host?: string;
};

const CREDENTIAL_PATTERNS = [
  /terminal prompts disabled/i,
  /could not read (?:Username|Password) for/i,
  /Authentication failed for/i,
  /Permission denied \([a-z,-]+\)/i,
  /requested URL returned error: 401/i,
  /Invalid username or password/i,
];

/** Returns the failure kind and host, or undefined when stderr is not an auth problem. */
export function classifyRemoteAuthFailure(
  stderr: string,
): RemoteAuthFailure | undefined {
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED/.test(stderr))
    return { kind: "host-key-changed", host: findHost(stderr) };
  if (/Host key verification failed/i.test(stderr))
    return { kind: "host-key", host: findHost(stderr) };
  if (CREDENTIAL_PATTERNS.some((pattern) => pattern.test(stderr)))
    return { kind: "credentials", host: findHost(stderr) };
  return undefined;
}

function findHost(stderr: string): string | undefined {
  // "could not read Username for 'https://github.com': ..."
  // "Authentication failed for 'https://github.com/o/r.git/'"
  const url = /for '[a-z+]+:\/\/(?:[^@/']*@)?([^/:']+)/i.exec(stderr);
  if (url) return url[1];
  // "git@github.com: Permission denied (publickey)."
  const scp = /^(?:[^@\s]+@)?([^\s:@]+): Permission denied/im.exec(stderr);
  if (scp) return scp[1];
  // "No ED25519 host key is known for github.com and you have requested ..."
  const known = /host key is known for ([^\s,]+)/i.exec(stderr);
  if (known) return known[1];
  // "The authenticity of host 'github.com (140.82.121.4)' can't be established."
  const authenticity = /authenticity of host '([^\s']+)/i.exec(stderr);
  if (authenticity) return authenticity[1];
  // "Offending ECDSA key in /home/u/.ssh/known_hosts:3" has no host. Skip it.
  return undefined;
}

const LABEL: Record<RemoteOperation, string> = {
  fetch: "Fetch",
  pull: "Pull",
  push: "Push",
};

/** Builds the short status-bar message for an auth failure. */
export function describeRemoteAuthFailure(
  operation: RemoteOperation,
  failure: RemoteAuthFailure,
  remote?: string,
): string {
  const name =
    remote && failure.host && failure.host !== remote
      ? `${remote} (${failure.host})`
      : (remote ?? failure.host ?? "the remote");
  const label = LABEL[operation];
  if (failure.kind === "host-key-changed")
    return `${label} stopped. The SSH host key for ${name} changed. Check the server, then update ~/.ssh/known_hosts.`;
  if (failure.kind === "host-key")
    return `${label} stopped. SSH does not trust the host key for ${name}. Run ssh to that host once in a terminal to accept it.`;
  return `${label} needs credentials for ${name}. Set up a credential helper or an SSH key in an agent.`;
}
