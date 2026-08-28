import type { ReactNode } from "react";
import { Button as AriaButton, Dialog, DialogTrigger, Heading, Modal, ModalOverlay } from "react-aria-components";

export function Button(props: { readonly children: ReactNode; readonly onPress?: () => void; readonly isDisabled?: boolean; readonly className?: string; readonly "aria-label"?: string }) {
  return <AriaButton {...props} />;
}

export function ConfirmDialog(props: { readonly trigger: ReactNode; readonly title: string; readonly children: ReactNode; readonly confirmLabel: string; readonly onConfirm: () => void }) {
  return <DialogTrigger>
    {props.trigger}
    <ModalOverlay className="modal-overlay" isDismissable>
      <Modal className="modal">
        <Dialog className="dialog">
          {({ close }) => <>
            <Heading slot="title">{props.title}</Heading>
            <div>{props.children}</div>
            <div className="dialog-actions">
              <Button onPress={close}>Cancel</Button>
              <Button className="primary" onPress={() => { props.onConfirm(); close(); }}>{props.confirmLabel}</Button>
            </div>
          </>}
        </Dialog>
      </Modal>
    </ModalOverlay>
  </DialogTrigger>;
}
