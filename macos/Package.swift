// swift-tools-version:5.9
//
// The JARVIS app for macOS. Built into JARVIS.app by build.sh (or `npm run mac`
// from the repository root) — SwiftPM compiles the binary, the script wraps it
// in an app bundle with the interface inside.
//
// Swift 5 language mode on purpose: the app hops between the main thread and
// background queues with plain GCD, which Swift 6's strict checking would
// reject wholesale without making anything here safer.

import PackageDescription

let package = Package(
    name: "JarvisMac",
    platforms: [.macOS(.v13)],
    products: [
        .executable(name: "JARVIS", targets: ["JarvisMac"]),
    ],
    targets: [
        .executableTarget(
            name: "JarvisMac",
            path: "Sources/JarvisMac",
            linkerSettings: [
                .linkedFramework("AppKit"),
                .linkedFramework("WebKit"),
                .linkedFramework("Network"),
                .linkedFramework("IOKit"),
                .linkedFramework("Contacts"),
                .linkedFramework("UserNotifications"),
                .linkedFramework("ServiceManagement"),
            ]
        ),
    ]
)
