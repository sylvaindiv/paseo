# Mac capture requests

On macOS 14 or later, the desktop app owns the global modifier shortcut and the
hold gesture. Hold Option + Control to speak and paint a trail with the pointer,
then release either modifier to open a task draft. Escape or an extra key cancels. No mouse
button is needed, and the foreground application keeps focus. A transparent native
overlay follows the pointer; the screenshot taken on release excludes helper
windows and receives the same trail plus a crop.

A preloaded hidden renderer joins the dictation and screenshot, then presents the
Projets task form on the local daemon regardless of the main window's selected
host. The draft stays open through plugin reloads. The configured Projets capture
profile reads the request after **Envoyer**. The board commits tasks and the
capture ID in one transaction, so retrying a recorded capture cannot duplicate it.
Use **File → Capture** to request macOS permissions or change the modifier chord.

The source window's location, selection, bounded accessibility snapshot and OCR
are project hints. The project selected in the form takes precedence, followed
by a project named in the request. The source window's accessibility URLs are
checked on disk. Secure fields are skipped.

The Swift helper is compiled for the target architecture during `afterPack` and
signed as an explicit additional binary. Keep it outside `app.asar`; launch it
only on supported macOS versions. Its pipe carries screenshots and accessible
content: never log complete messages or image data.

Desktop control is attached to the capture's device and agent. Registration and
responses belong to one physical client source. The daemon checks the agent's
current Plan mode before dispatch, including after waiting for its turn. The
native **Arrêter** panel revokes locally before contacting the daemon. Disconnect,
unknown outcome and timeout revoke the session; actions are never replayed.
A completed agent turn releases the controller. Another agent waits for release.

## Verification

Run the new capture cases in `packages/desktop/e2e/desktop-capture.spec.ts` and the
`desktop host commands` case in `owned-subscriptions.e2e.test.ts`. They use isolated
daemons. The renderer fixture proves hold-to-dictate, release-to-draft, confirmation and
duplicate prevention, not global keyboard delivery, macOS permissions or packaged signing.

Compile and run `native/desktop-capture/ShortcutTests.swift` with
`ModifierShortcut.swift` and `CaptureContext.swift` to check the modifier state machine without sending keys
to the user's applications. Test permission denial, fullscreen and mixed-scale
monitors on a signed app before claiming complete local delivery.
