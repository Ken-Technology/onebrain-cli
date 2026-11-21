import { onebrainConnection } from '@useonebrain/eve';

// One Brain's MCP server as a connection: the six tools, without recall or capture. The model
// finds them with eve__search and calls them as onebrain__search and the rest; write and forget
// wait for a person's approval. ONEBRAIN_API_KEY goes as the Bearer token to ONEBRAIN_URL/mcp.
export default onebrainConnection();
