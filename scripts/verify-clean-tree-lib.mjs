export function assertCleanRepositoryStatus(porcelainStatus) {
  const changes = porcelainStatus.trim();
  if (changes.length === 0) return;

  throw new Error(
    `Verification changed the repository or left untracked files:\n${changes}`,
  );
}
