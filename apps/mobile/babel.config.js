module.exports = function (api) {
  api.cache(true);
  return {
    // Absolute paths via require.resolve — inside the monorepo the hoisted @babel/core
    // otherwise fails to resolve these by bare name.
    presets: [require.resolve("babel-preset-expo")],
    // react-native-worklets/plugin powers Reanimated 4 and must be listed last.
    plugins: [require.resolve("react-native-worklets/plugin")],
  };
};
