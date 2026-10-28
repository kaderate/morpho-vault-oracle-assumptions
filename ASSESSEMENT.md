# Candidate Brief - Backend Engineering Assessment

Welcome to Morpho's Backend Engineering Assessment. This brief has everything you need to complete and submit your project.

# The Brief

Build something useful for the Morpho ecosystem.

Spend **up to 5 hours** building a backend service that interacts with Morpho's onchain data. What you build and how you scope it is entirely up to you.

# Deliverables

1. A working codebase pushed to a **GitHub repo**, which includes all workflow artifacts
2. A short **`BusinessCase.md`** (1 page max) introducing what you built, why you think it's valuable to Morpho, and how you'd improve it if you had more time
3. A **high-level architecture section** in your README — doesn't need to be detailed, just enough to orient us when we review it
4. **Instructions on how to run your project locally** if it's not hosted somewhere

We're evaluating your judgement, your understanding of the Morpho ecosystem, and your backend engineering skills — not your ability to build a polished product. A smaller, well-scoped project is better than a sprawling half-working prototype.

# Guidelines

## Do

- Use **TypeScript**
- Include a **real data store** — use any DB you want, but be prepared to justify your choice
- Expose your data through a **REST or GraphQL API**, whichever you prefer
- **Interact with onchain data** — read from Morpho markets contracts and/or Morpho vaults contracts using an RPC. Don't use the Morpho API for this
- **Spend time on the memo** — your reasoning about what's valuable and how you scoped the work tells us as much as the code

## Don't

- Don't spend much (or any) time building a frontend. We're totally happy to interact with a simple curl/GraphQL playground
- Don't over-invest in DevOps. A `docker-compose.yml` that boots your service is plenty. If you do host it, we don't need Terraform, K8s manifests, or CI pipelines — keep it simple
- Don't write new smart contracts
- Don't succumb to scope creep. A narrow but well-modeled domain with clean data flow beats three half-baked features
- Don't ignore error cases, data integrity, and failure paths
- Don't include code you can't explain — we're going to ask you about it!

# Submission

**Important:** Please do not send zip files, code attachments, or any downloadable files. For security reasons, we only accept GitHub repo links.

When you're ready:

1. Send us the link to your GitHub repo (do this via the notes section in the Ashby link sent to you)
2. Please add the following GitHub users as collaborators (read access) on your repo so our team can review your code:

Good luck!
