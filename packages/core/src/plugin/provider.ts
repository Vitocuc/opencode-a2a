import { GepetoPlugin } from "./provider/gepeto.js"
import type { PluginInternal } from "./internal.js"

// Podarcis offers Gepeto models only. The other provider plugins stay in the tree so upstream merges and their tests
// keep working, but they are not registered.
export const ProviderPlugins: PluginInternal.InternalPlugin[] = [GepetoPlugin]
