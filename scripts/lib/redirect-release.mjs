export function imageRevision(image) {
  const match = /^shortlink-redirect:([a-f0-9]{40})$/.exec(image);
  if (!match)
    throw new Error(`Expected a commit-tagged Fastify image, got ${image}`);
  return match[1];
}

export function imageDigest(value) {
  const match = /(?:^|@)(sha256:[a-f0-9]{64})$/.exec(value ?? "");
  if (!match) throw new Error(`Missing image digest: ${value}`);
  return match[1];
}

export function templateRelease(template) {
  const image = template.spec.containers.find(
    (container) => container.name === "api",
  )?.image;
  const revision = imageRevision(image);
  const annotations = template.metadata.annotations ?? {};
  if (annotations["shortlink.dev/git-revision"] !== revision)
    throw new Error("Pod template revision does not match its image tag");
  return {
    image,
    revision,
    digest: imageDigest(annotations["shortlink.dev/image-digest"]),
  };
}

export function rollbackTarget(deployment, replicaSets, requested) {
  const current = Number(
    deployment.metadata.annotations["deployment.kubernetes.io/revision"],
  );
  if (requested !== undefined && !/^[1-9][0-9]*$/.test(requested))
    throw new Error(
      "Rollback revision must be a positive Kubernetes revision number",
    );
  const candidates = replicaSets
    .filter((set) =>
      set.metadata.ownerReferences?.some(
        (owner) => owner.uid === deployment.metadata.uid,
      ),
    )
    .map((set) => ({
      set,
      number: Number(
        set.metadata.annotations["deployment.kubernetes.io/revision"],
      ),
    }))
    .filter(({ number }) => Number.isSafeInteger(number) && number < current)
    .sort((a, b) => b.number - a.number);
  const selected =
    requested === undefined
      ? candidates[0]
      : candidates.find(({ number }) => number === Number(requested));
  if (!selected)
    throw new Error(
      "No retained earlier Deployment revision matches the rollback request",
    );
  return {
    kubernetesRevision: selected.number,
    ...templateRelease(selected.set.spec.template),
  };
}

export function servingPods(pods, release, replicas) {
  const serving = pods.filter((pod) => !pod.metadata.deletionTimestamp);
  if (serving.length !== replicas)
    throw new Error(
      `Expected ${replicas} serving pods; found ${serving.length}`,
    );
  for (const pod of serving) {
    const container = pod.spec.containers.find((item) => item.name === "api");
    const status = pod.status.containerStatuses?.find(
      (item) => item.name === "api",
    );
    const ready = pod.status.conditions?.some(
      (condition) => condition.type === "Ready" && condition.status === "True",
    );
    if (
      !ready ||
      !status?.ready ||
      container?.image !== release.image ||
      imageDigest(status.imageID) !== release.digest
    )
      throw new Error(
        `Pod ${pod.metadata.name} is not ready on the expected image and digest`,
      );
  }
  return serving;
}

export function reportedRevision(metrics) {
  const match = /^shortlink_build_info\{revision="([a-f0-9]{40})"\} 1$/m.exec(
    metrics,
  );
  if (!match)
    throw new Error(
      "Pod does not report a commit revision in shortlink_build_info",
    );
  return match[1];
}
