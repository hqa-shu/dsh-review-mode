# Roadmap · actively under development

## Present in the snapshot

- Local conversation selection and shared dispatch pipeline.
- Independent reviewer context and bounded evidence preparation.
- Side-panel rendering with separate pending/failure/result states.
- New-message detection, advice routing and runtime diagnostics.
- Regression tests using host/UI doubles and local record fixtures.

These items describe code coverage, not feature-quality certification.

## Next

- Validate clean installation on a second machine and simplify SDK setup.
- Remove retained legacy remote-service code and reconcile outdated comments.
- Strengthen per-conversation selection, evidence minimization and user-visible data controls.
- Check model inheritance and failure recovery against the actual host UI.
- Add an explicit compatibility matrix for Harness and Codex record formats.

## Evaluation and usability

- Build a publishable synthetic corpus for goal drift, evidence gaps, and useful versus noisy advice.
- Measure quality and cost with a declared method and reproducible results.
- Improve onboarding, target switching, panel accessibility and layout.
- Add secret-handling safeguards before recommending use with sensitive records.

## Before a stable release

- Choose a license and document the dependency/licensing boundary.
- Establish release/versioning and upgrade procedures.
- Publish validated installation and compatibility results.
- Review the whole data path and state clearly what remains unsupported.
