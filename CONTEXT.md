# Stella Runtime Context

Stella Runtime is a public, instance-neutral cognitive runtime. This glossary
keeps the public engine, a private Agent instance, its authority repository, and
its live runtime state from being conflated.

## Language

**Cognitive Runtime**:
The generic engine that validates cognitive contracts, selects relevant context,
and integrates that context with a host Agent loop. It owns no durable personal
truth.
_Avoid_: Stella instance, personal knowledge base, Agent persona

**Runtime Package**:
The single versioned distribution containing the Plugin runtime, CLI, public
contracts, framework-admission Skill, and required self-check assets.
_Avoid_: runtime bundle, CLI package, Skill package

**Cognitive Contract**:
An instance-neutral, versioned schema in the `cognitive-runtime.<contract>/v2`
namespace that defines inputs, outputs, identity, authority, or trace semantics.
_Avoid_: Stella schema, private data format

**Personal Data Exchange Contract**:
A cross-product, versioned file contract in the `stella.<contract>/v1`
namespace for locating one Personal Data Repository and exchanging bounded
Runtime/Fitness projections. It is not part of the Cognitive Contract Set and
does not embed either product's private storage model.
_Avoid_: Cognitive Contract, mixed Contract Set, copied product configuration

**Contract Set**:
The coherent `/v2` collection of all public Runtime contracts used by one
Runtime Package and Generation. Composite Generations keep this Authority
Contract Set unchanged and add `/v3` Generation Manifest, Activation Receipt,
and Active Generation Pointer envelopes that bind verified domain projections.
_Avoid_: mixed contract versions, compatibility bundle, per-instance schema set

**Composite Generation Envelope**:
The `/v3` activation and identity envelope around one `/v2` Authority Contract
Set plus a sorted tuple of verified domain projection inputs. It does not create
a second Authority Contract Set or reinterpret any `/v2` artifact.
_Avoid_: Contract Set v3, mixed Authority schema, mutable domain overlay

**Private Instance**:
A deployment of the Cognitive Runtime bound to one private Agent's configuration,
authority data, session boundary, and version pin.
_Avoid_: tenant, built-in Stella behavior, public fixture

**Authority Repository**:
An external, private repository that is the auditable source for an instance's
durable knowledge, identity, cognitive definitions, configuration, and migration
records.
_Avoid_: Runtime repository, live state directory, generated index

**Authority Checkout**:
A consumer-owned, dedicated clean checkout or worktree used for automated
Authority publication and Generation builds without touching a user's ordinary
development workspace.
_Avoid_: user workspace, Runtime repository, automatic stash

**Source Revision**:
The exact committed Authority Repository revision whose verified tree is the
only input accepted by a Generation build.
_Avoid_: dirty working tree, latest files, Generation ID

**Runtime State**:
Private, Git-external data owned by one Private Instance, including authoritative
Current State and rebuildable operational projections. It is not source code and
is recovered through a Runtime Recovery Snapshot rather than ordinary Git files.
_Avoid_: authority repository, repository backup, source of truth

**Authoritative Runtime State**:
The minimal Git-external state whose loss would change the instance's current
meaning or leave a committed correction unfinished. It excludes projections that
can be rebuilt from the Authority Repository.
_Avoid_: all runtime files, cache, generated index

**Runtime Recovery Snapshot**:
A private, versioned, checksummed artifact exported and restored by the Runtime
to preserve Authoritative Runtime State across hosts without exposing its storage
implementation to the migration orchestrator.
_Avoid_: database copy, generation archive, authority repository

**Active Generation**:
The immutable, checksummed projection of one authority revision that is visible
to new Runs as a single `sync_generation`.
_Avoid_: mutable knowledge cache, second authority source

**Active Run Binding**:
The immutable combination of one Active Generation and one State View resolved
for an eligible Run when that Run begins. It never changes during the Run.
_Avoid_: static binding, live binding, latest configuration

**Projection Entry**:
A host-neutral, structured, checksummed retrieval unit derived from one authority
record in an Active Generation.
_Avoid_: Markdown file, memory chunk, authority record

**Public Author Corpus**:
A consumer-owned corpus of the user's published works that remains outside
private Authority and is retrieved through an independently configured path.
_Avoid_: private Evidence, unified Generation input, copied article authority

**Public Corpus Adapter**:
A consumer-provided, read-only integration that exposes the Public Author Corpus
to host retrieval without copying it into private Authority or Generation.
_Avoid_: Content Resolver, Authority Builder, arbitrary corpus scanner

**Evidence Migration Adapter**:
A consumer-owned, one-time adapter that maps legacy Evidence into valid v2
Source Packages while preserving the original source and assets unchanged.
_Avoid_: Runtime legacy parser, dual-format Builder, in-place frontmatter rewrite

**Builder Format Version**:
The explicit version of the deterministic normalization and projection rules
that contribute to a Generation identity independently of package release time.
_Avoid_: package version, build timestamp, Git commit

**Host Retrieval Projection**:
A host-specific, rebuildable rendering of Projection Entries that preserves their
Generation, stable IDs, roles, versions, and source references.
_Avoid_: authority corpus, independent index source, Consumer Integration

**Projection Document**:
An immutable host retrieval document whose versioned path and header agree on
its Generation, layer, stable ID, version, role, checksum, and source references.
_Avoid_: mutable memory file, unversioned chunk, authority document

**Runtime-managed Retrieval Path**:
An OpenClaw `extraPaths` entry explicitly owned by one Private Instance's
Generation Consumption. `sync` may replace only these owned entries and must
preserve unrelated instance retrieval paths.
_Avoid_: all extraPaths, user-managed corpus, Authority path

**Bootstrap Projection**:
An optional, minimal `USER.md` or `MEMORY.md` rendering of stable summaries and
references for a host workspace. The Runtime can generate it, but a Private
Instance decides whether and where to deploy it.
_Avoid_: authority document, required Generation artifact, editable memory source

**Bootstrap Alias**:
A stable reference marking that a minimal Bootstrap Projection and a retrieval
entry represent the same Authority record, so the host cannot count them as
independent evidence.
_Avoid_: duplicate evidence, copied claim, separate stable ID

**Temporal Value**:
A validated Evidence time paired with its declared `year`, `month`, `day`, or
`instant` precision; only an instant carries time-zone semantics.
_Avoid_: invented date, free-form timestamp, implicit precision

**State Initialization**:
The explicit creation of a Private Instance's first empty Current State head.
It distinguishes a valid empty state from missing or lost Runtime State.
_Avoid_: implicit empty database, first correction

**State Import**:
The audited initial migration of validated historical state into a Private
Instance. It does not request successor responses for the imported events.
_Avoid_: State Correction, database seed, SQLite copy

**State Import Manifest**:
The checksummed batch contract that binds an initialized empty Head, ordered
normalized Events and source mappings, and the expected final Head and State
View for one idempotent State Import.
_Avoid_: legacy data file, SQLite snapshot, correction list

**Imported Baseline**:
A State Event that records a legacy current value only after that exact value is
newly user-confirmed or independently verified, while declaring earlier history
unknown.
_Avoid_: unconfirmed snapshot import, reconstructed history, ordinary observation

**State Correction**:
A runtime change to Current State that advances the active head and requests a
response in a distinct successor Run.
_Avoid_: State Import, in-place edit, model inference

**Correction Preview**:
An exact proposed Current State Event shown for deterministic user confirmation
before State Correction.
_Avoid_: Authority Candidate, model inference, committed event

**State Correction Receipt**:
A single-use Confirmed Channel record of one exact Correction Preview. It is
consumed atomically with the correction event and successor outbox.
_Avoid_: Approval Receipt, chat agreement, reusable mutation token

**Pending Activation**:
The operational condition in which an immutable Authority Version is committed
but its Generation has not yet passed `sync` and become active.
_Avoid_: draft authority, rolled-back authority, active generation

**Synchronization Gap**:
The observable difference between the latest committed Authority Source Revision
and the Source Revision represented by the Active Generation. Intermediate
committed Authority Versions remain auditable even when synchronization safely
coalesces them into a later target revision.
_Avoid_: Candidate queue, publication failure, version state machine

**Instance Runtime Config**:
The non-authoritative configuration locating one Private Instance, its Runtime
and Generation storage, OpenClaw agent, Authority Owner policy, operating mode,
eligible private session scope, and limits without embedding cognitive content.
_Avoid_: Runtime Binding, Authority Repository, Registry copy

**Instance Cutover Plan**:
The instance-owned, exact transition contract declaring publication prerequisites,
legacy retrieval paths and duplicate mechanisms to remove, independent paths to
preserve, and Bootstrap targets to deploy within one Activation Barrier.
_Avoid_: migration runbook, Runtime default, manual post-sync cleanup

**Eligible Run**:
A Run inside the Private Instance's explicitly configured private main Agent and
session scope. Internal completions, confirmation callbacks, operational probes,
and public or shared Agents are not eligible.
_Avoid_: every Agent Run, Router completion, model-selected scope

**Discovery Authorization**:
A user-granted, scope-bound permission to generate Authority Candidates for one
declared workflow or invocation. Ending it invalidates every unresolved Request
created under that authorization.
_Avoid_: standing consent, Candidate lifecycle, ordinary conversation

**Authority Candidate**:
A complete proposed Semantic Claim, Personal Model Claim, or Cognitive Entity
presented as an exact checksummed version before it may enter authority.
_Avoid_: Current State candidate, draft inference, admitted authority

**Candidate Revision**:
One immutable revision of a stable Candidate ID, binding its complete content,
source map, base Authority Version, exact diff, and checksum for review.
_Avoid_: Approval Message Reference, mutable draft, Authority Version

**Change Set**:
The immutable, idempotent, consumer-owned publication unit derived from one
approved Candidate Revision, containing all exact Authority operations and base
checks required to publish it atomically.
_Avoid_: Git commit, Candidate lifecycle, partial Entity write

**Confirmation Request**:
A deterministic request asking the Authority Owner to decide on one exact
Candidate Revision, its complete review artifact, and its exact change from a
specific Authority Version within a live Discovery Authorization.
_Avoid_: conversational suggestion, model interpretation, approval receipt

**Candidate Review Artifact**:
The complete immutable Candidate, exact diff from its base Authority Version,
target identity and version, and checksums presented for a decision. Pagination
or linking may change presentation but not the approved artifact.
_Avoid_: Candidate summary, chat explanation, mutable preview

**Approval Message Reference**:
A host-scoped reference to the instance, account or channel, conversation, and
message that presented one exact Candidate Revision, checksum, and diff for a
decision.
_Avoid_: bare message ID, Candidate identity, Change Set identity

**Approval Receipt**:
A machine-readable Decision Receipt that authorizes one exact Authority
Candidate Revision and checksum to be published once. Exact publication retries are
idempotent, but successful Authority persistence consumes the authorization.
_Avoid_: model decision, chat transcript, reusable approval

**Decision Receipt**:
A machine-readable record of an explicit accepted, rejected, or finally
rewritten decision about one exact Authority Candidate. Only an Approval Receipt
authorizes publication.
_Avoid_: rewrite request, Candidate lifecycle record, model decision

**Receipt Withdrawal**:
A durable pre-publication revocation of an unconsumed Confirmation Request or
Decision Receipt by an identity permitted under the consumer's authorization
policy.
_Avoid_: deleting a draft, expiring a session, Authority correction

**Admission Service**:
The Runtime boundary that validates Decision Receipts, enforces single-use
publication semantics, and dispatches an exact Candidate to its type-specific
content validator.
_Avoid_: Confirmation Gateway, Candidate editor, publishing service

**Authority Publishing Service**:
The consumer-owned boundary that atomically applies a validated Change Set and
records which Approval Receipt authorized it, without implementing Runtime
validation rules.
_Avoid_: Generation Builder, Confirmation Gateway, Candidate validator

**Publication Journal**:
The durable, minimal recovery record that binds one Approval Receipt, exact
Change Set, Candidate checksum, and resulting Source Revision across the
consumer's Git commit and Runtime Receipt consumption steps.
_Avoid_: Candidate state machine, distributed transaction coordinator, chat log

**Authority Version**:
An immutable version of one stable Semantic Claim, Personal Model Claim, or
Cognitive Entity. Corrections create a later version rather than deleting or
overwriting history.
_Avoid_: mutable authority file, amended version, Active Generation

**Confirmation Gateway**:
The boundary that captures an Authority Owner's deterministic button, approval
card, or command decision and issues a Decision Receipt without LLM
interpretation.
_Avoid_: framework validator, publishing service, natural-language confirmation

**Confirmed Channel**:
A host channel whose deterministic approval entry, authenticated actor context,
and Approval Message Reference have passed exact-version capability smoke.
_Avoid_: configured channel, inferred callback support, text approval

**Local Trust Boundary**:
The single-user, single-host boundary in which configured provider identity,
local operator access, protected Runtime State, and consumer publication storage
are trusted without a separate signing or identity infrastructure.
_Avoid_: multi-tenant authorization, cross-domain receipt, public-key identity

**Confirmation Routing Token**:
A high-entropy opaque capability that locates one Confirmation Request without
carrying Candidate content or approval authority. It becomes unusable when the
Request is decided, withdrawn, invalidated, or consumed.
_Avoid_: Candidate ID, signed approval, callback dedupe key

**Activation Barrier**:
A bounded maintenance boundary that prevents eligible private Runs while one
Host Retrieval Projection is configured, indexed, verified, and made visible
with its matching Active Generation.
_Avoid_: pointer update, background convergence, eventual activation

**Maintenance Gate**:
The durable fail-closed state checked before Run Binding while an Activation
Barrier or its recovery is incomplete, or while verified domain input drift is
quarantined pending a corrective sync. A drift quarantine does not turn a
completed Sync Journal back into an interrupted Barrier.
_Avoid_: CLI process lock, operator convention, Gateway shutdown

**Sync Journal**:
The durable record of pre-sync host state, intended Generation, completed sync
steps, and recovery progress used to resume or reverse an interrupted Barrier.
_Avoid_: log file, Active Pointer, Recovery Snapshot

**Activation Receipt**:
The machine-readable proof that one Generation, Host Retrieval Projection, host
configuration, and verified retrieval index were consistent before the Active
Generation became visible.
_Avoid_: activation log, active pointer, deployment note

**Publication Status Reply**:
A deterministic update to the Approval Message Reference that distinguishes
Candidate acceptance, durable Authority publication, and successful activation,
or reports a Synchronization Gap while the prior Generation continues serving.
_Avoid_: model-generated explanation, approval acknowledgement, Runtime log

**Runtime Reconciliation**:
A full verification of the active Generation, Projection, host configuration,
index health, and retrieval behavior that renews or invalidates an Activation
Receipt outside an ordinary Run.
_Avoid_: per-Run deep probe, background best effort, log inspection

**Compatibility Matrix Row**:
The support claim for one release channel, exact OpenClaw version, and exact
Node version, backed by package installation and capability smoke evidence.
_Avoid_: minimum supported version, version greater than or equal to

**Capability Smoke**:
A real-host verification that an exact OpenClaw version exposes the fields,
ordering, and behavior required by one compatibility matrix row.
_Avoid_: type-check only, rolling documentation assumption

**Instance Test Pack**:
A private or de-identified set of instance configuration, fixtures, and
assertions consumed by the public Runner without copying the Runner itself.
_Avoid_: public personal data, forked test framework

**Runtime Requirement Baseline**:
The versioned, repository-local requirements, architecture, decisions, host
evidence, and roadmap that are sufficient to implement and release the Runtime.
_Avoid_: private-repository design source, external handoff notes

**Generation Consumption**:
The generic Runtime behavior that makes one Active Generation and one immutable
State View available to an eligible new Run, including the matching host
retrieval projection. It is part of the Cognitive Runtime, not downstream
instance glue.
_Avoid_: manual binding, Consumer Integration, instance migration

**Generation Consumption Acceptance**:
An exact-host end-to-end proof from approved Authority publication through
Generation build, host projection and index verification, Activation Receipt
and Pointer commit, to a new Eligible Run binding the intended Generation.
_Avoid_: unit test, pointer inspection, host startup

**Instance Integration**:
The downstream work that binds a Private Instance's authority mapping, paths,
host configuration, version pin, and deployment acceptance to the Runtime
Package. It does not define or implement Generation Consumption.
_Avoid_: Runtime implementation dependency, copied Runtime source, Consumer Integration

**Experience Record**:
A private record of a real user's prompt, trace, correction, and usefulness
judgment. It remains Git-external and is never a public Golden fixture.
_Avoid_: synthetic Golden, telemetry sample, public evaluation corpus
