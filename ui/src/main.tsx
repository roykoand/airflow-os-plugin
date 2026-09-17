import type { FC } from "react";

import { AirflowOS } from "./os/AirflowOS";

/**
 * Plugin entry point.
 *
 * Airflow's core UI dynamically imports this bundle and renders the default export
 * at the plugin's `url_route`. The desktop deliberately does not use the host's
 * Chakra theme: it draws its own Windows 95 chrome, scoped under `.aos` so neither
 * side's styles leak into the other.
 */
const PluginComponent: FC = () => <AirflowOS />;

export default PluginComponent;
