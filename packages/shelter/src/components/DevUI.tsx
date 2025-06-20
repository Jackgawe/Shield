import { Divider, Header, HeaderTags, LinkButton, showToast, Space, SwitchItem } from "@uwu/shelter-ui";
import { dbStore } from "../storage";
import { PluginCard } from "./Plugins";
import { devModeReservedId, enableDevmode, stopDevmode } from "../devmode";
import { installedPlugins } from "../plugins";
import { createMemo, Show } from "solid-js";

// fullVersion shows the header and the toggle for always showing the mini menu
export default (props: { fullVersion?: boolean }) => {
  const devModeOn = createMemo(() => {
    const plugins = installedPlugins();
    return devModeReservedId in plugins;
  });

  return (
    <>
      <SwitchItem checked={dbStore.logDispatch} onChange={(v) => (dbStore.logDispatch = v)}>
        Log FluxDispatcher events to the console
      </SwitchItem>

      <SwitchItem
        hideBorder
        checked={devModeOn()}
        onChange={(val) =>
          val
            ? enableDevmode().catch((e) =>
                showToast({
                  title: "Could not enable dev mode",
                  content: e.message,
                  duration: 3000,
                }),
              )
            : stopDevmode()
        }
        note={
          devModeOn() ? (
            <>
              shelter is currently tethered to
              <Space />
              <LinkButton href="https://github.com/uwu/shelter/tree/main/packages/lune#readme">Lune</LinkButton>
              <Space />
              via dev mode. To disable dev mode, close Lune.
              <br />
              The following dev plugin is loaded:
            </>
          ) : (
            <>
              When in dev mode, shelter tethers to a running
              <Space />
              <LinkButton href="https://github.com/uwu/shelter/tree/main/packages/lune#readme">Lune</LinkButton>
              <Space />
              dev server, allowing hot reloading of a temporary dev plugin.
            </>
          )
        }
      >
        Lune Dev Mode
      </SwitchItem>

      <Show when={installedPlugins()[devModeReservedId]} keyed>
        {(plugin) => <PluginCard id={devModeReservedId} plugin={plugin} />}
      </Show>

      <Show when={props.fullVersion}>
        <SwitchItem
          hideBorder={true}
          checked={dbStore.alwaysDevMenu}
          onChange={(v) => (dbStore.alwaysDevMenu = v)}
          note={
            "The developer tools menu icon shows when lune dev mode is enabled, turning this on shows it at all times."
          }
        >
          Always show developer tools menu icon
        </SwitchItem>
      </Show>
    </>
  );
};
