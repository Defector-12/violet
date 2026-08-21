// swift-tools-version: 6.1

import PackageDescription

let package = Package(
    name: "VioletMacOS",
    platforms: [
        .macOS(.v14)
    ],
    products: [
        .library(name: "VioletProtocolClient", targets: ["VioletProtocolClient"]),
        .library(name: "VioletMacCore", targets: ["VioletMacCore"]),
        .executable(name: "Violet", targets: ["VioletApp"]),
        .executable(name: "violet-credential", targets: ["VioletCredentialTool"])
    ],
    dependencies: [
        .package(
            url: "https://github.com/apple/swift-http-types",
            from: "1.3.0"
        ),
        .package(
            url: "https://github.com/apple/swift-openapi-generator",
            from: "1.13.0"
        ),
        .package(
            url: "https://github.com/apple/swift-openapi-runtime",
            from: "1.0.0"
        ),
        .package(
            url: "https://github.com/apple/swift-openapi-urlsession",
            from: "1.3.1"
        ),
    ],
    targets: [
        .target(
            name: "VioletProtocolClient",
            dependencies: [
                .product(name: "HTTPTypes", package: "swift-http-types"),
                .product(name: "OpenAPIRuntime", package: "swift-openapi-runtime"),
                .product(name: "OpenAPIURLSession", package: "swift-openapi-urlsession"),
            ],
            plugins: [
                .plugin(name: "OpenAPIGenerator", package: "swift-openapi-generator")
            ]
        ),
        .target(
            name: "VioletMacCore",
            dependencies: [
                "VioletProtocolClient",
                .product(name: "OpenAPIRuntime", package: "swift-openapi-runtime")
            ]
        ),
        .executableTarget(
            name: "VioletApp",
            dependencies: ["VioletMacCore"]
        ),
        .executableTarget(
            name: "VioletCredentialTool",
            dependencies: ["VioletMacCore"]
        ),
        .testTarget(
            name: "VioletMacCoreTests",
            dependencies: [
                "VioletMacCore",
                "VioletProtocolClient",
            ]
        )
    ]
)
