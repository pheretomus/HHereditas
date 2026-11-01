# Android build environment for HHereditas (Tauri 2).
# Use:  source apps/android-viewer/android-env.sh
# or add to ~/.bashrc:  . "$HOME/HHereditas/apps/android-viewer/android-env.sh"
export JAVA_HOME="$HOME/Android/jdk-17"
export ANDROID_HOME="$HOME/Android/Sdk"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export NDK_HOME="$ANDROID_HOME/ndk/27.2.12479018"
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$PATH"

# Gradle runs inside the launcher JVM (no daemon, see gen/android/gradle.properties): its heap/encoding must match
# org.gradle.jvmargs, the instrumentation agent is not required, and the module opens a daemon JVM would get are added here.
export GRADLE_OPTS="-Xmx2048m -Dfile.encoding=UTF-8 -Dorg.gradle.internal.instrumentation.agent=false --add-opens=java.base/java.lang=ALL-UNNAMED --add-opens=java.base/java.lang.invoke=ALL-UNNAMED --add-opens=java.base/java.util=ALL-UNNAMED --add-opens=java.prefs/java.util.prefs=ALL-UNNAMED --add-opens=java.base/java.nio.charset=ALL-UNNAMED --add-opens=java.base/java.net=ALL-UNNAMED --add-opens=java.base/java.util.concurrent=ALL-UNNAMED --add-opens=java.base/java.util.concurrent.atomic=ALL-UNNAMED --add-opens=java.xml/javax.xml.namespace=ALL-UNNAMED --add-opens=java.base/java.time=ALL-UNNAMED --add-exports=jdk.compiler/com.sun.tools.javac.api=ALL-UNNAMED --add-exports=jdk.compiler/com.sun.tools.javac.util=ALL-UNNAMED"
