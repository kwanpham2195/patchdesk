# Choose an Analysis completion action per run

Every Analysis run has an explicit completion action: save as a Review draft, open the publication preview, publish as Comment, publish as Approve, or publish as Request changes. **Open preview when complete** is the default.

Choosing a publication action authorizes that GitHub write for the current run only. Patchdesk binds the authorization to the profile, pull request, head revision, and patch. It cancels automatic publication when the revision or detected remote state changes, when an existing draft would be overwritten, or when Analysis does not complete successfully.
