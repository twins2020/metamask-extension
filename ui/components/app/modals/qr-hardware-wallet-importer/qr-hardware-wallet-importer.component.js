import React, { Component } from 'react';
import PropTypes from 'prop-types';
import log from 'loglevel';
import { BrowserQRCodeReader } from '@zxing/library';
import { getEnvironmentType } from '../../../../../app/scripts/lib/util';
import { ENVIRONMENT_TYPE_FULLSCREEN } from '../../../../../shared/constants/app';
import Spinner from '../../../ui/spinner';
import WebcamUtils from '../../../../helpers/utils/webcam-utils';
import PageContainerFooter from '../../../ui/page-container/page-container-footer/page-container-footer.component';
import { URDecoder } from '@ngraveio/bc-ur';

const READY_STATE = {
  ACCESSING_CAMERA: 'ACCESSING_CAMERA',
  NEED_TO_ALLOW_ACCESS: 'NEED_TO_ALLOW_ACCESS',
  READY: 'READY',
};

export default class QRHardwareWalletImporter extends Component {
  static propTypes = {
    hideModal: PropTypes.func.isRequired,
    submitQRHardwareCryptoHDKey: PropTypes.func.isRequired,
    cancelReadQRHardwareCryptoHDKey: PropTypes.func.isRequired,
    history: PropTypes.object,
  };

  static contextTypes = {
    t: PropTypes.func,
  };

  constructor(props) {
    super(props);

    this.state = this.getInitialState();
    this.codeReader = null;
    this.permissionChecker = null;
    this.mounted = false;
  }

  componentDidMount() {
    this.mounted = true;
    this.checkEnvironment();
  }

  componentDidUpdate(_, prevState) {
    const { ready } = this.state;

    if (prevState.ready !== ready) {
      if (ready === READY_STATE.READY) {
        this.initCamera();
      } else if (ready === READY_STATE.NEED_TO_ALLOW_ACCESS) {
        this.checkPermissions();
      }
    }
  }

  getInitialState() {
    return {
      ready: READY_STATE.ACCESSING_CAMERA,
      error: null,
    };
  }

  checkEnvironment = async () => {
    try {
      const { environmentReady } = await WebcamUtils.checkStatus();
      if (
        !environmentReady &&
        getEnvironmentType() !== ENVIRONMENT_TYPE_FULLSCREEN
      ) {
        const currentUrl = new URL(window.location.href);
        const currentHash = currentUrl.hash;
        const currentRoute = currentHash ? currentHash.substring(1) : null;
        global.platform.openExtensionInBrowser(currentRoute);
      }
    } catch (error) {
      if (this.mounted) {
        this.setState({ error });
      }
    }
    // initial attempt is required to trigger permission prompt
    this.initCamera();
  };

  checkPermissions = async () => {
    try {
      const { permissions } = await WebcamUtils.checkStatus();
      if (permissions) {
        // Let the video stream load first...
        await new Promise((resolve) => setTimeout(resolve, 2000));
        if (!this.mounted) {
          return;
        }
        this.setState({ ready: READY_STATE.READY });
      } else if (this.mounted) {
        // Keep checking for permissions
        this.permissionChecker = setTimeout(this.checkPermissions, 1000);
      }
    } catch (error) {
      if (this.mounted) {
        this.setState({ error });
      }
    }
  };

  componentWillUnmount() {
    this.mounted = false;
    clearTimeout(this.permissionChecker);
    this.teardownCodeReader();
  }

  teardownCodeReader() {
    if (this.codeReader) {
      this.codeReader.reset();
      this.codeReader.stop();
      this.codeReader = null;
    }
  }

  initCamera = async () => {
    // The `decodeFromInputVideoDevice` call prompts the browser to show
    // the user the camera permission request.  We must then call it again
    // once we receive permission so that the video displays.
    // It's important to prevent this codeReader from being created twice;
    // Firefox otherwise starts 2 video streams, one of which cannot be stopped
    if (!this.codeReader) {
      this.codeReader = new BrowserQRCodeReader();
    }
    try {
      await this.codeReader.getVideoInputDevices();
      this.checkPermissions();
      const content = await this.codeReader.decodeFromInputVideoDevice(
        undefined,
        'video',
      );
      const result = this.parseContent(content.text);
      if (!this.mounted) {
        return;
      } else if (result.type === 'unknown') {
        this.setState({ error: new Error(this.context.t('unknownQrCode')) });
      } else {
        this.props.submitQRHardwareCryptoHDKey(result.data);
        this.stopAndClose();
      }
    } catch (error) {
      if (!this.mounted) {
        return;
      }
      if (error.name === 'NotAllowedError') {
        log.info(`Permission denied: '${error}'`);
        this.setState({ ready: READY_STATE.NEED_TO_ALLOW_ACCESS });
      } else {
        this.setState({ error });
      }
    }
  };

  parseContent(content) {
    //TODO: deal with different UR types
    try {
      const urDecoder = new URDecoder();
      urDecoder.receivePart(content);
      const ur = urDecoder.resultUR();
      return { type: 'qr-hardware-wallet', data: ur.cbor.toString('hex') };
    } catch (e) {
      log.error(e);
    }
  }

  stopAndClose = () => {
    if (this.codeReader) {
      this.teardownCodeReader();
    }
    this.props.hideModal();
  };

  cancel = () => {
    if (this.codeReader) {
      this.teardownCodeReader();
    }
    const { history } = this.props;
    this.props.hideModal();
    this.props.cancelReadQRHardwareCryptoHDKey();
    history.goBack();
  };

  tryAgain = () => {
    clearTimeout(this.permissionChecker);
    if (this.codeReader) {
      this.teardownCodeReader();
    }
    this.setState(this.getInitialState(), () => {
      this.checkEnvironment();
    });
  };

  renderError() {
    const { t } = this.context;
    const { error } = this.state;

    let title, msg;
    if (error.type === 'NO_WEBCAM_FOUND') {
      title = t('noWebcamFoundTitle');
      msg = t('noWebcamFound');
    } else if (error.message === t('unknownQrCode')) {
      msg = t('unknownQrCode');
    } else {
      title = t('unknownCameraErrorTitle');
      msg = t('unknownCameraError');
    }

    return (
      <>
        <div className="qr-scanner__image">
          <img src="images/webcam.svg" width="70" height="70" alt="" />
        </div>
        {title ? <div className="qr-scanner__title">{title}</div> : null}
        <div className="qr-scanner__error">{msg}</div>
        <PageContainerFooter
          onCancel={this.cancel}
          onSubmit={this.tryAgain}
          cancelText={t('cancel')}
          submitText={t('tryAgain')}
          submitButtonType="confirm"
        />
      </>
    );
  }

  renderVideo() {
    const { t } = this.context;
    const { ready } = this.state;

    let message;
    if (ready === READY_STATE.ACCESSING_CAMERA) {
      message = t('accessingYourCamera');
    } else if (ready === READY_STATE.READY) {
      message = t('scanInstructions');
    } else if (ready === READY_STATE.NEED_TO_ALLOW_ACCESS) {
      message = t('youNeedToAllowCameraAccess');
    }

    return (
      <>
        <div className="qr-scanner__title">{`${t('scanQrCode')}`}</div>
        <div className="qr-scanner__content">
          <div className="qr-scanner__content__video-wrapper">
            <video
              id="video"
              style={{
                display: ready === READY_STATE.READY ? 'block' : 'none',
              }}
            />
            {ready === READY_STATE.READY ? null : <Spinner color="#F7C06C" />}
          </div>
        </div>
        <div className="qr-scanner__status">{message}</div>
      </>
    );
  }

  render() {
    const { error } = this.state;
    return (
      <div className="qr-scanner">
        <div className="qr-scanner__close" onClick={this.cancel} />
        {error ? this.renderError() : this.renderVideo()}
      </div>
    );
  }
}
