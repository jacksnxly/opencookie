/** @packageDocumentation */

export type {
  FileSystemPort,
  PackageManager,
  SupportedFramework,
} from "./contracts.js";
export {
  CliDetectionError,
  detectFramework,
  detectPackageManager,
} from "./detect.js";
export {
  buildInstallCommand,
  CliConflictError,
  initializeProject,
  planInitialization,
  type CliPorts,
  type CommandInvocation,
  type CommandPort,
  type ExistingFileEdit,
  type GeneratedFile,
  type InitializationPlan,
  type InitializeProjectOptions,
  type InitializeProjectResult,
  type PlanInitializationOptions,
  type VanillaBrowserAsset,
} from "./init.js";
export {
  createNodeCliPorts,
  createNodeFileSystem,
  nodeCommandPort,
  type NodeCliPortsOptions,
} from "./node.js";
export {
  publishPolicyToStore,
  readPolicyPublicationLog,
  rollbackPolicyInStore,
  type FailedPolicyStoreOperation,
  type PolicyPublishRequest,
  type PolicyRollbackStoreRequest,
  type PolicyStoreIssue,
  type PolicyStoreReadResult,
  type PolicyStoreWriteResult,
  type RejectedPolicyPublicationIssue,
  type SuccessfulPolicyStoreRead,
  type SuccessfulPolicyStoreWrite,
  type UnreadablePolicyStoreIssue,
} from "./policy-store.js";
export {
  currentPolicyPublication,
  emptyPolicyPublicationLog,
  isPublicationId,
  publishPolicy,
  rollbackPolicyPublication,
  type BlankPublicationIdIssue,
  type DuplicatePublicationIdIssue,
  type FailedPolicyPublication,
  type InvalidPublicationIdIssue,
  type PolicyPublication,
  type PolicyPublicationIssue,
  type PolicyPublicationLog,
  type PolicyPublicationRequest,
  type PolicyPublicationResult,
  type PolicyRollbackRequest,
  type SuccessfulPolicyPublication,
  type UnchangedCurrentPolicyIssue,
  type ChangedPolicySameVersionIssue,
  type UnknownPublicationIssue,
} from "./publication-log.js";
export {
  parsePolicyPublicationLog,
  serializePolicyPublicationLog,
  type FailedPolicyPublicationParse,
  type MalformedPublicationDocumentIssue,
  type PolicyPublicationParseIssue,
  type PolicyPublicationParseResult,
  type PublicationDigestMismatchIssue,
  type SuccessfulPolicyPublicationParse,
} from "./serialize-publication-log.js";
export {
  buildPolicyDeclaration,
  type DeclarationPurpose,
  type DeclarationSection,
  type PolicyDeclaration,
} from "./policy-declaration.js";
export {
  INSTALLED_POLICY_PATH,
  POLICY_DECLARATION_PATH,
  POLICY_PUBLICATION_STORE_PATH,
  runPolicyCommand,
  STARTER_POLICY_PATH,
  type PolicyCommandPorts,
  type PolicyCommandResult,
} from "./policy-command.js";
export {
  classifyFinding,
  emptyFindingsInventory,
  FINDING_CLEANUPS,
  FINDING_KINDS,
  FINDING_UNCERTAINTIES,
  importObservedFindings,
  type Finding,
  type FindingCleanup,
  type FindingKind,
  type FindingObservation,
  type BlankPurposeIssue,
  type ClassifyFindingIssue,
  type ClassifyFindingRequest,
  type ClassifyFindingResult,
  type IncompleteDecisionIssue,
  type UnsupportedCleanupIssue,
  type FindingDecision,
  type FindingsImportIssue,
  type FindingsImportResult,
  type FindingsInventory,
  type FindingUncertainty,
  type MalformedObservationIssue,
  type UnsupportedFindingKindIssue,
  type InvalidFindingPatternIssue,
  type UnknownFindingIssue,
  type UnsupportedUncertaintyIssue,
} from "./findings.js";
export {
  FINDINGS_INVENTORY_PATH,
  POLICY_DRAFT_PATH,
  runFindingsCommand,
  type FindingsCommandPorts,
  type FindingsCommandResult,
} from "./findings-command.js";
export {
  draftPolicyFromFindings,
  REQUIRED_PURPOSE_FIELDS,
  type DraftFindingReference,
  type DraftPurpose,
  type NoClassifiedFindingsIssue,
  type PolicyDraft,
  type PolicyDraftResult,
} from "./policy-draft.js";
export {
  declarePolicyTerms,
  type BlankTermLabelIssue,
  type CategoryTermIssue,
  type DisclosedReference,
  type DisclosureIssue,
  type DisclosureResult,
  type PolicyTerm,
  type PolicyTerms,
  type UndisclosedReferenceIssue,
  type UnreferencedTermIssue,
} from "./disclosure.js";
export {
  definePolicyLawfulBases,
  type BlankLawfulBasisIssue,
  type LawfulBasisIssue,
  type LawfulBasisResult,
  type PolicyLawfulBases,
  type UnknownPurposeBasisIssue,
} from "./lawful-basis.js";
export {
  runDoctor,
  type Diagnostic,
  type DiagnosticSeverity,
  type DoctorOptions,
  type DoctorPorts,
  type DoctorResult,
} from "./doctor.js";
export {
  applyEvidenceRetention,
  deleteEvidenceForConsent,
  emptyEvidenceLog,
  ingestReceipts,
  queryEvidence,
  type EvidenceIngestIssue,
  type EvidenceIngestResult,
  type EvidenceLog,
  type EvidenceQuery,
  type IdempotencyConflictIssue,
  type MalformedReceiptIssue,
} from "./evidence-log.js";
export {
  EVIDENCE_STORE_PATH,
  runEvidenceCommand,
  type EvidenceCommandPorts,
  type EvidenceCommandResult,
} from "./evidence-command.js";
export { scanHtml, type HtmlScanObservation } from "./html-scan.js";
export {
  emptySiteRegistry,
  registerSite,
  siteDirectory,
  siteForDomain,
  type DomainClaimedIssue,
  type DuplicateSiteIssue,
  type InvalidDomainIssue,
  type InvalidSiteNameIssue,
  type NoDomainsIssue,
  type Site,
  type SiteRegistration,
  type SiteRegistrationIssue,
  type SiteRegistrationResult,
  type SiteRegistry,
} from "./site-registry.js";
export {
  openSite,
  runSitesCommand,
  selectSite,
  SITE_REGISTRY_PATH,
  type OpenSiteResult,
  type SelectSiteResult,
  type SitesCommandPorts,
  type SitesCommandResult,
} from "./sites-command.js";
export { scanHar, type SessionScanObservation } from "./har-scan.js";
export { scanStorageSnapshot } from "./storage-scan.js";
export {
  createMemorySessionStore,
  type CreatedOperatorSession,
  type MemorySessionStoreOptions,
  type OperatorSession,
  type OperatorSessionStore,
} from "./operator-session.js";
export {
  createSignInLimiter,
  handleOperatorRequest,
  OPERATOR_SESSION_COOKIE,
  type OperatorRequest,
  type OperatorResponse,
  type OperatorServerPorts,
  type OperatorSignInLimiter,
} from "./operator-server.js";
export {
  planServe,
  serveGreeting,
  type ServePlan,
  type ServePlanResult,
} from "./serve-command.js";
// `createOperatorRequestListener` stays internal: its signature is Node's own
// IncomingMessage and ServerResponse, and a public package API that names them
// forces every consumer of this package to carry Node's types.
export {
  startOperatorConsole,
  type RunningOperatorConsole,
} from "./serve-node.js";
