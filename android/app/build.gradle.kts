import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// 배포용(release) 서명 정보는 저장소 밖(~/.android/text-tunnel-release.properties)에서 읽는다 — 키스토어·비밀번호는 절대 저장소에 두지 않는다.
// 같은 키로 서명해야 앱을 지우지 않고 업데이트할 수 있으니 이 키스토어는 백업해 둘 것.
val signProps = Properties().apply {
    val f = file(System.getenv("TT_KEYSTORE_PROPS") ?: "${System.getProperty("user.home")}/.android/text-tunnel-release.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}

android {
    namespace = "dev.esstional.texttunnel.phone"
    compileSdk = 35

    defaultConfig {
        applicationId = "dev.esstional.texttunnel.phone"
        minSdk = 26
        targetSdk = 35
        versionCode = 2
        versionName = "0.2.0"
    }
    signingConfigs {
        if (signProps.getProperty("storeFile") != null) {
            create("release") {
                storeFile = file(signProps.getProperty("storeFile"))
                storePassword = signProps.getProperty("storePassword")
                keyAlias = signProps.getProperty("keyAlias")
                keyPassword = signProps.getProperty("keyPassword")
            }
        }
    }
    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.findByName("release")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    buildFeatures { buildConfig = true }
}

kotlin {
    compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17) }
}
