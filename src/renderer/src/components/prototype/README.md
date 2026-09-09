# Sidebar navigation prototype (issue #119)

Throwaway prototype for issue #119: Patchdesk is removing the header workspace
selector and the repository picker, leaving a persistent left sidebar as the
only navigation. This folder exists to answer one question — what hierarchy
should that sidebar have, and what is its primary affordance — by putting real
workspace/repo data behind stubbed pull-request rows and looking at it. Run it
by appending `?variant=A` (later `B`, `C`) to the renderer URL of the dev app;
with no `?variant=` the app is exactly what it is today. The whole thing is
gated on `import.meta.env.DEV`, the pull-request rows are fixtures rather than
GitHub reads, and none of it is wired to real review opening. It must not ship,
and nothing outside this folder should import from it except the one mount in
`src/renderer/src/components/app-shell.tsx`.
