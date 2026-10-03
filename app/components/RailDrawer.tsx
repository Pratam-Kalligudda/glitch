import * as Dialog from "@radix-ui/react-dialog";
import { useRef, useState } from "react";
import type { PartOutline } from "../../content/view";
import { Rail } from "./Rail";

interface Props {
  slug: string;
  parts: PartOutline[];
  current: string;
  doneIds: ReadonlySet<string>;
  nextId: string | null;
}

/** The rail as a slide-in drawer for narrow screens. */
export function RailDrawer({ slug, parts, current, doneIds, nextId }: Props) {
  const [open, setOpen] = useState(false);
  // The dialog's scroll lock swallows the anchor jump, so scroll once it has closed.
  const navigated = useRef(false);

  function scrollToHash(event: Event) {
    if (!navigated.current) return;
    navigated.current = false;
    const target = document.getElementById(decodeURIComponent(window.location.hash.slice(1)));
    if (!target) return;
    event.preventDefault();
    target.scrollIntoView();
  }

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger className="parts-trigger">Parts</Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="drawer-overlay" />
        <Dialog.Content className="drawer" aria-describedby={undefined} onCloseAutoFocus={scrollToHash}>
          <Dialog.Title className="drawer-title">Parts</Dialog.Title>
          <Rail
            slug={slug}
            parts={parts}
            current={current}
            doneIds={doneIds}
            nextId={nextId}
            onNavigate={() => {
              navigated.current = true;
              setOpen(false);
            }}
          />
          <Dialog.Close className="drawer-close" aria-label="Close">
            <span aria-hidden="true">×</span>
          </Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
