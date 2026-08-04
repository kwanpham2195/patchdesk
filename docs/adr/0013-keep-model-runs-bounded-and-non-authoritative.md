# Keep model runs bounded and non-authoritative

Patchdesk owns every Analysis and Walkthrough workflow. The app prepares immutable revision artifacts, starts one finite model run, validates a strict structured result, and decides whether that result may replace retained content or enter the Review draft.

Analysis instructions keep trusted Patchdesk policy above untrusted repository criteria and prepared pull request evidence. Analysis receives only session-bound changed-file inspection and immutable Git reads. Walkthrough receives bounded stored artifacts with no tools or write surface. Neither workflow can mutate the checkout, access credentials, write to GitHub, publish feedback, change threads, or merge.

Patchdesk computes Finding mapping, postability, freshness, publication authorization, and merge eligibility after model output passes validation. Exact prompt wording, default models, reasoning defaults, and tuning may change without changing this authority boundary.
