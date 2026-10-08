import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const searchSkillPath = join(__dirname, '../../skills_ref/jaw-search/SKILL.md');
const devSkillPath = join(__dirname, '../../skills_ref/jaw-dev/SKILL.md');
const devDebuggingSkillPath = join(__dirname, '../../skills_ref/jaw-dev-debugging/SKILL.md');
const devSecuritySkillPath = join(__dirname, '../../skills_ref/jaw-dev-security/SKILL.md');
const devDevopsSkillPath = join(__dirname, '../../skills_ref/jaw-dev-devops/SKILL.md');
const devBackendSkillPath = join(__dirname, '../../skills_ref/jaw-dev-backend/SKILL.md');
const devFrontendSkillPath = join(__dirname, '../../skills_ref/jaw-dev-frontend/SKILL.md');
const devTestingSkillPath = join(__dirname, '../../skills_ref/jaw-dev-testing/SKILL.md');
const devDataSkillPath = join(__dirname, '../../skills_ref/jaw-dev-data/SKILL.md');
const devCodeReviewerSkillPath = join(__dirname, '../../skills_ref/jaw-dev-code-reviewer/SKILL.md');
const devArchitectureSkillPath = join(__dirname, '../../skills_ref/jaw-dev-architecture/SKILL.md');
const devScaffoldingSkillPath = join(__dirname, '../../skills_ref/jaw-dev-scaffolding/SKILL.md');
const devUiuxDesignSkillPath = join(__dirname, '../../skills_ref/jaw-dev-uiux-design/SKILL.md');
const registryPath = join(__dirname, '../../skills_ref/registry.json');
const hasSearchSkill = fs.existsSync(searchSkillPath);
const hasDevSkill = fs.existsSync(devSkillPath);
const hasDevDebuggingSkill = fs.existsSync(devDebuggingSkillPath);
const hasDevSecuritySkill = fs.existsSync(devSecuritySkillPath);
const hasDevDevopsSkill = fs.existsSync(devDevopsSkillPath);
const hasDevBackendSkill = fs.existsSync(devBackendSkillPath);
const hasDevFrontendSkill = fs.existsSync(devFrontendSkillPath);
const hasDevTestingSkill = fs.existsSync(devTestingSkillPath);
const hasDevDataSkill = fs.existsSync(devDataSkillPath);
const hasDevCodeReviewerSkill = fs.existsSync(devCodeReviewerSkillPath);
const hasDevArchitectureSkill = fs.existsSync(devArchitectureSkillPath);
const hasDevScaffoldingSkill = fs.existsSync(devScaffoldingSkillPath);
const hasDevUiuxDesignSkill = fs.existsSync(devUiuxDesignSkillPath);

test('SSP-001: restored search skill is a registered unified search hub', { skip: !hasSearchSkill && 'skills_ref/search missing' }, () => {
    const searchSkill = fs.readFileSync(searchSkillPath, 'utf8');
    const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));

    assert.match(searchSkill, /name: jaw-search/);
    assert.match(searchSkill, /Unified search hub/);
    assert.match(searchSkill, /4-tier escalation/);
    assert.ok(registry.skills['jaw-search'], 'registry should include search skill');
    assert.equal(registry.skills['jaw-search'].category, 'research');
});

test('SSP-002: search skill keeps four-tier escalation order', { skip: !hasSearchSkill && 'skills_ref/search missing' }, () => {
    const searchSkill = fs.readFileSync(searchSkillPath, 'utf8');

    assert.match(searchSkill, /Tier 1 — Built-in CLI Web Search/);
    assert.match(searchSkill, /Tier 2 — cli-jaw browser/);
    assert.match(searchSkill, /Tier 3 — progrok/);
    assert.match(searchSkill, /Tier 4 — web-ai/);
    assert.ok(
        searchSkill.indexOf('Tier 2 — cli-jaw browser') < searchSkill.indexOf('Tier 3 — progrok'),
        'browser verification should come before progrok'
    );
    assert.match(searchSkill, /Order is mandatory/);
});

test('SSP-003: Korean search policy treats snippets as discovery and requires original evidence', { skip: !hasSearchSkill && 'skills_ref/search missing' }, () => {
    const searchSkill = fs.readFileSync(searchSkillPath, 'utf8');

    assert.match(searchSkill, /Search is discovery, not evidence/);
    assert.match(searchSkill, /1-3 focused keyword queries/);
    assert.match(searchSkill, /URL candidates only/);
    assert.match(searchSkill, /Fetch\/open the original page/);
    assert.match(searchSkill, /browse-needed/);
    assert.match(searchSkill, /Naver shell\/iframe/);
    assert.match(searchSkill, /run Tier 2 browser verification before relying on secondary sources/);
    assert.match(searchSkill, /Secondary sources are corroboration, not substitutes/);
});

test('SSP-004: browser gate starts browser before skipping Tier 2', { skip: !hasSearchSkill && 'skills_ref/search missing' }, () => {
    const searchSkill = fs.readFileSync(searchSkillPath, 'utf8');

    assert.match(searchSkill, /run `cli-jaw browser start --agent` and retry\s+status\/fetch once/);
    assert.match(searchSkill, /Skip Tier 2 only if browser start, status, or fetch still\s+fails/);
    assert.doesNotMatch(searchSkill, /browser not connected\), skip that tier/);
});

test('SSP-005: search skill does not hardcode a specific Jaw home', { skip: !hasSearchSkill && 'skills_ref/search missing' }, () => {
    const searchSkill = fs.readFileSync(searchSkillPath, 'utf8');

    assert.doesNotMatch(searchSkill, /\/Users\/jun\/\.cli-jaw-\d+/);
    assert.match(searchSkill, /active `browser` skill from the current Jaw home/);
    assert.match(searchSkill, /active `web-ai` skill from the current Jaw home/);
});

test('SSP-006: agbrowse remains an optional planner, not a provider runner', { skip: !hasSearchSkill && 'skills_ref/search missing' }, () => {
    const searchSkill = fs.readFileSync(searchSkillPath, 'utf8');

    assert.match(searchSkill, /agbrowse research plan --query "<request>" --json/);
    assert.match(searchSkill, /plan\.atomicQueries/);
    assert.match(searchSkill, /optional planning helper/);
    assert.match(searchSkill, /Do not use agbrowse to execute Exa,\s+Tavily, Perplexity, Brave, or any other search provider/);
});

test('SSP-007: /search is a routing command, not a provider implementation', { skip: !hasSearchSkill && 'skills_ref/search missing' }, () => {
    const searchSkill = fs.readFileSync(searchSkillPath, 'utf8');

    assert.match(searchSkill, /`\/search <query>` is a routing command, not a provider implementation/);
    assert.match(searchSkill, /inherit this skill's routing\/evidence invariants/);
    assert.match(searchSkill, /discover candidate URLs/);
    assert.match(searchSkill, /Slash-specific report fields/);
    assert.doesNotMatch(searchSkill, /Final report fields:/);
    assert.doesNotMatch(searchSkill, /focused_queries|search_route_used|candidate_urls|original_pages_opened_or_fetched/);
    assert.doesNotMatch(searchSkill, /browse_escalation_decision|final_answer|evidence_status|remaining_uncertainty/);
});

test('SSP-008: search skill routes public source classes to browser reader policy', { skip: !hasSearchSkill && 'skills_ref/search missing' }, () => {
    const searchSkill = fs.readFileSync(searchSkillPath, 'utf8');

    assert.match(searchSkill, /Public-source reader routing map/);
    assert.match(searchSkill, /known source classes toward `browser fetch` \/ adaptive-fetch/);
    assert.match(searchSkill, /Package registries/);
    assert.match(searchSkill, /Academic\/library records/);
    assert.match(searchSkill, /Korean portals, Naver pages/);
    assert.match(searchSkill, /Media pages/);
    assert.match(searchSkill, /Archive-needed or removed pages/);
    assert.match(searchSkill, /requires login, payment, private membership, CAPTCHA solving/);
});

test('SSP-009: model-gated parallel research is bounded and evidence-gated', { skip: !hasSearchSkill && 'skills_ref/search missing' }, () => {
    const searchSkill = fs.readFileSync(searchSkillPath, 'utf8');

    assert.match(searchSkill, /Model-gated parallel research/);
    assert.match(searchSkill, /Use single-agent search by default/);
    assert.match(searchSkill, /cap it at 2-4 lanes/);
    assert.match(searchSkill, /official/);
    assert.match(searchSkill, /community/);
    assert.match(searchSkill, /realtime/);
    assert.match(searchSkill, /fetch/);
    assert.match(searchSkill, /Merge lane outputs into one evidence matrix/);
    assert.match(searchSkill, /Parallel snippets still do not\s+count as sufficient evidence/);
});

test('SSP-010: evidence status vocabulary is explicit', { skip: !hasSearchSkill && 'skills_ref/search missing' }, () => {
    const searchSkill = fs.readFileSync(searchSkillPath, 'utf8');

    assert.match(searchSkill, /Evidence status:/);
    assert.match(searchSkill, /`sufficient`: at least one original\/primary URL was opened or fetched/);
    assert.match(searchSkill, /`partial`: candidate evidence exists/);
    assert.match(searchSkill, /`browse-needed`: a candidate primary URL exists/);
    assert.match(searchSkill, /`insufficient`: no credible candidate evidence was obtained/);
});

test('SSP-011: search remains standalone owner for external evidence policy', { skip: !hasSearchSkill && 'skills_ref/search missing' }, () => {
    const searchSkill = fs.readFileSync(searchSkillPath, 'utf8');

    assert.match(searchSkill, /Standalone owner/);
    assert.match(searchSkill, /other skills may point here for external\/current evidence/);
    assert.match(searchSkill, /should not copy this tier policy/);
    assert.match(searchSkill, /Update this skill first/);
});

test('SSP-012: common dev skill points external current evidence to search', { skip: !hasDevSkill && 'skills_ref/dev missing' }, () => {
    const devSkill = fs.readFileSync(devSkillPath, 'utf8');

    assert.match(devSkill, /External\/current evidence/);
    assert.match(devSkill, /current versions, release notes, CVEs, package\/source checks, or provider\s+behavior/);
    assert.match(devSkill, /read the active `(?:jaw-)?search` skill/);
    assert.match(devSkill, /query-rewrite, source-fetch, and\s+evidence-status rules/);
    assert.doesNotMatch(devSkill, /\/Users\/jun\/\.cli-jaw-\d+/);
});

test('SSP-013: debugging skill routes current upstream bug evidence to search', { skip: !hasDevDebuggingSkill && 'skills_ref/dev-debugging missing' }, () => {
    const devDebuggingSkill = fs.readFileSync(devDebuggingSkillPath, 'utf8');

    assert.match(devDebuggingSkill, /third-party library\/API\/framework behavior/);
    assert.match(devDebuggingSkill, /current\s+error workarounds, upstream issues, changelogs, or migration guides/);
    assert.match(devDebuggingSkill, /read the\s+active `(?:jaw-)?search` skill/);
    assert.match(devDebuggingSkill, /source-fetch and evidence-status rules/);
    assert.doesNotMatch(devDebuggingSkill, /4-tier escalation/);
    assert.doesNotMatch(devDebuggingSkill, /\/Users\/jun\/\.cli-jaw-\d+/);
});

test('SSP-014: security skill routes current supply-chain evidence to search', { skip: !hasDevSecuritySkill && 'skills_ref/dev-security missing' }, () => {
    const devSecuritySkill = fs.readFileSync(devSecuritySkillPath, 'utf8');

    assert.match(devSecuritySkill, /current CVEs, advisories, package maintainer\/source checks/);
    assert.match(devSecuritySkill, /release\s+integrity claims, or registry trust changes/);
    assert.match(devSecuritySkill, /read the active `(?:jaw-)?search` skill/);
    assert.match(devSecuritySkill, /query-rewrite, original-source fetch, and evidence-status rules/);
    assert.doesNotMatch(devSecuritySkill, /4-tier escalation/);
    assert.doesNotMatch(devSecuritySkill, /\/Users\/jun\/\.cli-jaw-\d+/);
});

test('SSP-015: devops skill routes current release and provider evidence to search', { skip: !hasDevDevopsSkill && 'skills_ref/dev-devops missing' }, () => {
    const devDevopsSkill = fs.readFileSync(devDevopsSkillPath, 'utf8');

    assert.match(devDevopsSkill, /release, registry-auth, provider-doc, service-status/);
    assert.match(devDevopsSkill, /image\/platform\s+version, or package-manager behavior/);
    assert.match(devDevopsSkill, /read\s+the active `(?:jaw-)?search` skill/);
    assert.match(devDevopsSkill, /source-fetch and evidence-status rules/);
    assert.doesNotMatch(devDevopsSkill, /4-tier escalation/);
    assert.doesNotMatch(devDevopsSkill, /\/Users\/jun\/\.cli-jaw-\d+/);
});

test('SSP-016: backend skill routes current API and provider evidence to search', { skip: !hasDevBackendSkill && 'skills_ref/dev-backend missing' }, () => {
    const devBackendSkill = fs.readFileSync(devBackendSkillPath, 'utf8');

    assert.match(devBackendSkill, /current external API docs, API lifecycle\s+changes/);
    assert.match(devBackendSkill, /LLM\/RAG provider behavior, dependency freshness/);
    assert.match(devBackendSkill, /package\/source\s+evidence/);
    assert.match(devBackendSkill, /read the active `(?:jaw-)?search` skill/);
    assert.match(devBackendSkill, /query-rewrite,\s+source-fetch, and evidence-status rules/);
    assert.doesNotMatch(devBackendSkill, /4-tier escalation/);
    assert.doesNotMatch(devBackendSkill, /\/Users\/jun\/\.cli-jaw-\d+/);
});

// Harmonization moved the per-router copy of the search policy into a single
// owner: `dev` §External Evidence and Recall Routing. A router may either
// restate the rules or delegate to that section — but delegation only counts
// when the target section actually exists, so SSP-016b pins it.
test('SSP-017: frontend skill routes current UI platform evidence to search', { skip: !hasDevFrontendSkill && 'skills_ref/dev-frontend missing' }, () => {
    const devFrontendSkill = fs.readFileSync(devFrontendSkillPath, 'utf8');

    assert.match(devFrontendSkill, /current framework, design-system, browser API/);
    assert.match(devFrontendSkill, /package\/source freshness/);
    assert.match(devFrontendSkill, /`(?:jaw-)?search` skill/);
    assert.match(
        devFrontendSkill,
        /(read the active `(?:jaw-)?search` skill[\s\S]{0,120}source-fetch and evidence-status\s+rules|follow `(?:jaw-)?dev` §External\s+Evidence and Recall Routing)/,
        'must either restate the search policy or delegate to the dev owner section',
    );
    assert.doesNotMatch(devFrontendSkill, /4-tier escalation/);
    assert.doesNotMatch(devFrontendSkill, /\/Users\/jun\/\.cli-jaw-\d+/);
});

test('SSP-018: testing skill routes current provider and environment evidence to search', { skip: !hasDevTestingSkill && 'skills_ref/dev-testing missing' }, () => {
    const devTestingSkill = fs.readFileSync(devTestingSkillPath, 'utf8');

    assert.match(devTestingSkill, /current external API behavior, provider docs/);
    assert.match(devTestingSkill, /CI service\s+behavior, test-environment versions/);
    assert.match(devTestingSkill, /dependency audit evidence, or recorded\s+mock\/fixture sources/);
    assert.match(devTestingSkill, /read the active `(?:jaw-)?search` skill/);
    assert.match(devTestingSkill, /source-fetch and evidence-status rules/);
    assert.doesNotMatch(devTestingSkill, /4-tier escalation/);
    assert.doesNotMatch(devTestingSkill, /\/Users\/jun\/\.cli-jaw-\d+/);
});

test('SSP-019: data skill routes current dataset and pipeline evidence to search', { skip: !hasDevDataSkill && 'skills_ref/dev-data missing' }, () => {
    const devDataSkill = fs.readFileSync(devDataSkillPath, 'utf8');

    assert.match(devDataSkill, /External\/current data evidence/);
    assert.match(devDataSkill, /current external dataset contracts, source freshness/);
    assert.match(devDataSkill, /pipeline\/tool version\s+behavior, provider data API changes/);
    assert.match(devDataSkill, /read the\s+active `(?:jaw-)?search` skill/);
    assert.match(devDataSkill, /query-rewrite, source-fetch, and\s+evidence-status rules/);
    assert.match(devDataSkill, /candidate URLs exist/);
    assert.doesNotMatch(devDataSkill, /4-tier escalation/);
    assert.doesNotMatch(devDataSkill, /\/Users\/jun\/\.cli-jaw-\d+/);
});

test('SSP-020: code reviewer routes current review evidence to search', { skip: !hasDevCodeReviewerSkill && 'skills_ref/dev-code-reviewer missing' }, () => {
    const devCodeReviewerSkill = fs.readFileSync(devCodeReviewerSkillPath, 'utf8');

    assert.match(devCodeReviewerSkill, /External\/current review evidence/);
    assert.match(devCodeReviewerSkill, /dependency CVEs, release-note claims/);
    assert.match(devCodeReviewerSkill, /package maintainer\/source checks,\s+provider behavior/);
    assert.match(devCodeReviewerSkill, /read the\s+active `(?:jaw-)?search` skill/);
    assert.match(devCodeReviewerSkill, /source-fetch, and\s+evidence-status rules/);
    assert.match(devCodeReviewerSkill, /not a raw-query search substitute/);
    assert.doesNotMatch(devCodeReviewerSkill, /4-tier escalation/);
    assert.doesNotMatch(devCodeReviewerSkill, /\/Users\/jun\/\.cli-jaw-\d+/);
});

test('SSP-021: architecture skill routes current platform evidence to search', { skip: !hasDevArchitectureSkill && 'skills_ref/dev-architecture missing' }, () => {
    const devArchitectureSkill = fs.readFileSync(devArchitectureSkillPath, 'utf8');

    assert.match(devArchitectureSkill, /External\/current architecture evidence/);
    assert.match(devArchitectureSkill, /current framework guidance, cloud\/provider reference\s+architecture/);
    assert.match(devArchitectureSkill, /package deprecation, platform limits/);
    assert.match(devArchitectureSkill, /read the active `(?:jaw-)?search` skill/);
    assert.match(devArchitectureSkill, /query-rewrite, source-fetch, and\s+evidence-status rules/);
    assert.match(devArchitectureSkill, /candidate URLs exist/);
    assert.doesNotMatch(devArchitectureSkill, /4-tier escalation/);
    assert.doesNotMatch(devArchitectureSkill, /\/Users\/jun\/\.cli-jaw-\d+/);
});

test('SSP-022: scaffolding skill routes current generator and template evidence to search', { skip: !hasDevScaffoldingSkill && 'skills_ref/dev-scaffolding missing' }, () => {
    const devScaffoldingSkill = fs.readFileSync(devScaffoldingSkillPath, 'utf8');

    assert.match(devScaffoldingSkill, /External\/current scaffolding evidence/);
    assert.match(devScaffoldingSkill, /current generator behavior, template commands/);
    assert.match(devScaffoldingSkill, /package versions, framework\s+recommendations/);
    assert.match(devScaffoldingSkill, /read the active `(?:jaw-)?search` skill/);
    assert.match(devScaffoldingSkill, /query-rewrite, source-fetch, and\s+evidence-status rules/);
    assert.match(devScaffoldingSkill, /candidate URLs exist/);
    assert.doesNotMatch(devScaffoldingSkill, /4-tier escalation/);
    assert.doesNotMatch(devScaffoldingSkill, /\/Users\/jun\/\.cli-jaw-\d+/);
});

test('SSP-023: UI/UX design skill routes current design evidence to search', { skip: !hasDevUiuxDesignSkill && 'skills_ref/dev-uiux-design missing' }, () => {
    const devUiuxDesignSkill = fs.readFileSync(devUiuxDesignSkillPath, 'utf8');

    assert.match(devUiuxDesignSkill, /External\/current design evidence/);
    assert.match(devUiuxDesignSkill, /live product-reference claims, current\s+design-system docs/);
    assert.match(devUiuxDesignSkill, /`(?:jaw-)?search` skill/);
    assert.match(
        devUiuxDesignSkill,
        /(read the active `(?:jaw-)?search` skill[\s\S]{0,160}evidence-status rules|follow `(?:jaw-)?dev` §External\s+Evidence and Recall Routing)/,
        'must either restate the search policy or delegate to the dev owner section',
    );
    assert.match(devUiuxDesignSkill, /candidate URLs exist/);
    assert.doesNotMatch(devUiuxDesignSkill, /4-tier escalation/);
    assert.doesNotMatch(devUiuxDesignSkill, /\/Users\/jun\/\.cli-jaw-\d+/);
});

// A delegating router is only safe if its target exists. Without this, a
// harmonization pass can point every surface at a section nobody wrote.
test('SSP-016b: routers that delegate the search policy point at a real dev section', { skip: !hasDevSkill && 'skills_ref/dev missing' }, () => {
    const devSkill = fs.readFileSync(devSkillPath, 'utf8');
    const delegators: Array<[string, boolean, string]> = [
        ['dev-frontend', hasDevFrontendSkill, devFrontendSkillPath],
        ['dev-uiux-design', hasDevUiuxDesignSkill, devUiuxDesignSkillPath],
    ];
    const delegates = delegators.filter(([, present, path]) =>
        present && /follow `(?:jaw-)?dev` §External\s+Evidence and Recall Routing/.test(fs.readFileSync(path, 'utf8')));
    if (!delegates.length) return;
    assert.match(
        devSkill,
        /^##+ External Evidence and Recall Routing$/m,
        `${delegates.map(([name]) => name).join(', ')} delegate to a dev section that must exist`,
    );
    assert.match(devSkill, /`(?:jaw-)?search` skill/);
});
