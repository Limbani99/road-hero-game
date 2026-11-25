import GameCanvas from '../component/GameCanvas.jsx'

function Home() {
  // Keep the game as the only full-screen page content on mobile.
  return (
    <main className="road-hero-page">
      <GameCanvas />
    </main>
  )
}

export default Home