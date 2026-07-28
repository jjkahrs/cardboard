import { Link } from 'react-router-dom';

export function NotFoundScreen() {
  return (
    <main className="cb-screen">
      <h1>No such page</h1>
      <p>That address doesn’t match anything in Cardboard.</p>
      <Link to="/">Back to your games</Link>
    </main>
  );
}
