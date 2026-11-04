// WP-08: the Credits list under Settings > General > About. Same entries as the README and NOTICE.
import { openUrl } from "@tauri-apps/plugin-opener";
import { CREDITED_COMPONENTS, INSPIRATIONS } from "../model/credits";

function SourceLink({ name, url }: { name: string; url: string }) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      onClick={(event) => {
        // Open in the browser, never inside the app's webview.
        event.preventDefault();
        void openUrl(url).catch(() => undefined);
      }}
      className="font-medium text-content underline decoration-content/25 underline-offset-2 hover:decoration-content/60"
    >
      {name}
    </a>
  );
}

export function CreditsList() {
  return (
    <div data-credits className="space-y-4 px-4 py-3.5 text-[12px] leading-relaxed">
      <section>
        <h3 className="pb-1.5 text-[12px] font-semibold text-content/70">
          Inspirations
        </h3>
        <ul className="space-y-1">
          {INSPIRATIONS.map((source) => (
            <li key={source.name} data-credit={source.name} className="text-content/60">
              <SourceLink name={source.name} url={source.url} />{" "}
              <span className="text-content/45">({source.licence})</span>:{" "}
              {source.gave}.
            </li>
          ))}
        </ul>
      </section>
      <section>
        <h3 className="pb-1.5 text-[12px] font-semibold text-content/70">
          Third-party code
        </h3>
        <ul className="space-y-1.5">
          {CREDITED_COMPONENTS.map((component) => (
            <li key={component.name} data-credit={component.name} className="text-content/60">
              <SourceLink name={component.name} url={component.url} />{" "}
              <span className="text-content/45">({component.licence})</span>
              <div className="text-content/45">
                {component.copyright}. {component.how}.
              </div>
            </li>
          ))}
        </ul>
        <p className="pt-2 text-content/45">
          MonoCode's own third-party notices are in the NOTICE file that comes with the source.
        </p>
      </section>
    </div>
  );
}
