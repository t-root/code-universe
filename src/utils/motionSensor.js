import { useCallback, useEffect, useState } from 'react';

/**
 * useMotionSensor
 *
 * Manages activation of the DeviceOrientation API (gyroscope / IMU) so the
 * user can rotate the camera by tilting the device. No camera input is used.
 *
 * - Only offered on touch devices (phones / tablets): desktop browsers often
 *   expose the API without a real gyroscope behind it.
 * - On iOS 13+ we must call `DeviceOrientationEvent.requestPermission()` from
 *   a user gesture (a button click) before the sensor will emit events.
 * - On Android the events start flowing as soon as the listener is attached.
 *
 * The hook dispatches a `code-universe:sensor` CustomEvent on `window` so the
 * CameraController can pick up activation/deactivation without prop-drilling.
 */
export function useMotionSensor() {
  const [available, setAvailable] = useState(false);
  const [active, setActive] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    const supported =
      typeof window.DeviceOrientationEvent === 'function' &&
      window.matchMedia('(pointer: coarse)').matches;
    setAvailable(Boolean(supported));
  }, []);

  const dispatch = useCallback((enabled) => {
    if (typeof window === 'undefined') return;
    window.dispatchEvent(
      new CustomEvent('code-universe:sensor', { detail: { enabled } })
    );
  }, []);

  const activate = useCallback(async () => {
    setError(null);
    try {
      // Mobile Chrome and Safari only expose motion data to a secure page.
      // `localhost` remains a trusted development exception, but a phone
      // opening the LAN address (http://192.168.x.x) must use HTTPS.
      const isLocalhost = ['localhost', '127.0.0.1', '::1'].includes(window.location.hostname);
      if (!window.isSecureContext && !isLocalhost) {
        setError('IMU cần HTTPS khi mở trên điện thoại. Hãy dùng liên kết https://');
        setActive(false);
        dispatch(false);
        return;
      }

      // iOS 13+ permission gate. Must run inside the click handler.
      const DOE = window.DeviceOrientationEvent;
      if (DOE && typeof DOE.requestPermission === 'function') {
        const result = await DOE.requestPermission();
        if (result !== 'granted') {
          setError('Sensor permission denied.');
          setActive(false);
          dispatch(false);
          return;
        }
      }
      setActive(true);
      dispatch(true);
    } catch (err) {
      setError(err?.message || 'Failed to activate motion sensor.');
      setActive(false);
      dispatch(false);
    }
  }, [dispatch]);

  const deactivate = useCallback(() => {
    setActive(false);
    setError(null);
    dispatch(false);
  }, [dispatch]);

  return { available, active, activate, deactivate, error };
}
