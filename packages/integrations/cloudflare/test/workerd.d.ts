// The workerd package's default export is the path of its binary; it ships no types.
declare module 'workerd' {
  const binary: string;
  export default binary;
}
