/* ====================================================================== */
/*  aviator-embed.jsx                                                     */
/*  The game screen an OPERATOR's own site iframes/redirects a player     */
/*  into, via the launch_url returned from POST /api/operator/launch.     */
/*  This page has no concept of a locally-registered user or JWT - the    */
/*  whole session is scoped to the one-time launch token in the URL,      */
/*  exchanged here for a short-lived operator session token used for the  */
/*  rest of the play session (see backend/src/operators.js session/start  */
/*  route). Reuses the same GameBoard/BetPanel/FlightStage that power the */
/*  normal logged-in-user game screen in aviator.jsx - only the API       */
/*  client, socket, and route prefix differ.                              */
/* ====================================================================== */

import React, { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { GameBoard } from './aviator.jsx';
import { startOperatorSession, createOperatorApiClient, getOperatorSocket } from '../app-shell.jsx';

export default function AviatorEmbed() {
  const [searchParams] = useSearchParams();
  const launchToken = searchParams.get('token');

  const [status, setStatus] = useState('loading'); // 'loading' | 'ready' | 'error'
  const [errorMessage, setErrorMessage] = useState(null);
  const [session, setSession] = useState(null); // { sessionToken, currency, operatorName, returnUrl }
  const [balance, setBalance] = useState(0);

  useEffect(() => {
    if (!launchToken) {
      setStatus('error');
      setErrorMessage('Missing launch token');
      return;
    }

    startOperatorSession(launchToken)
      .then((res) => {
        setSession({
          sessionToken: res.data.session_token,
          currency: res.data.currency,
          operatorName: res.data.operator_name,
          returnUrl: res.data.return_url,
        });
        setBalance(res.data.balance ?? 0);
        setStatus('ready');
      })
      .catch((err) => {
        setStatus('error');
        setErrorMessage(err.response?.data?.error || 'Could not start the game session. Please relaunch from your platform.');
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [launchToken]);

  if (status === 'loading') {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', color: '#f2f2f4' }}>
        Loading game...
      </div>
    );
  }

  if (status === 'error') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', color: '#f2f2f4', padding: 24, textAlign: 'center' }}>
        <p>{errorMessage}</p>
        {session?.returnUrl && (
          <a className="btn btn-outline" href={session.returnUrl} style={{ marginTop: 12 }}>
            Return to platform
          </a>
        )}
      </div>
    );
  }

  const apiClient = createOperatorApiClient(session.sessionToken);
  const createSocket = () => getOperatorSocket(session.sessionToken);

  return (
    <div className="container">
      <GameBoard
        apiClient={apiClient}
        createSocket={createSocket}
        endpointPrefix="/operator-game"
        externalBalance={balance}
        onExternalBalanceChange={setBalance}
        brandLabel="Aviator"
        currencyLabel={session.currency}
      />
    </div>
  );
}
