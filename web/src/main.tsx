import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { createBrowserRouter, RouterProvider } from 'react-router-dom'
import App from './App'
import DashboardPage from './pages/DashboardPage'
import NotebookPage from './pages/NotebookPage'
import NotePage from './features/editor/NotePage'
import StudyPage from './features/study/StudyPage'
import AskPage from './features/ask/AskPage'
import CapturePage from './features/import/CapturePage'
import './styles/index.css'

const router = createBrowserRouter([
  // Phone capture flow renders without the desktop shell.
  { path: '/capture', element: <CapturePage /> },
  {
    path: '/',
    element: <App />,
    children: [
      { index: true, element: <DashboardPage /> },
      { path: 'notebook/:notebookId', element: <NotebookPage /> },
      { path: 'note/:noteId', element: <NotePage /> },
      { path: 'study', element: <StudyPage /> },
      { path: 'ask', element: <AskPage /> },
    ],
  },
])

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
)
